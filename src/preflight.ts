import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildCatalog } from "./catalog.ts";
import type { Agent, Config } from "./config.ts";
import { readCache } from "./state.ts";

const exec = promisify(execFile);

async function readVersion(cmd?: string[] | null): Promise<string | null> {
  if (!cmd?.length) return null;
  const [command, ...args] = cmd;
  try {
    const { stdout } = await exec(command, args, { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function compareVersions(installed: string, latest: string): number {
  const left = installed.split(".").map(BigInt);
  const right = latest.split(".").map(BigInt);
  const index = left.findIndex((part, i) => part !== right[i]);
  return index < 0 ? 0 : left[index] < right[index] ? -1 : 1;
}

async function versionReport(agent: Agent) {
  const [installed, latest] = await Promise.all([readVersion(agent.version_cmd), readVersion(agent.latest_cmd)]);
  const comparison = installed && latest ? compareVersions(installed, latest) : null;
  // Newer than the registry's latest (a prerelease, or a registry that lags) is not behind.
  const status = comparison === null ? "unknown" : comparison === -1 ? "outdated" : "current";
  return { installed, latest, status, update_cmd: agent.update_cmd ?? null };
}

function benchmarkStatus(config: Config["benchmarks"]) {
  if (!config) return "not configured";
  const cache = readCache<{ sources?: Record<string, { fetched_at?: string }> }>("benchmarks.json");
  if (!cache?.sources) return "missing";
  const cutoff = Date.now() - (config.max_age_days ?? 7) * 86_400_000;
  const ids = config.sources?.map(({ id }) => id) ?? Object.keys(cache.sources);
  const timestamps = ids.map((id) => Date.parse(cache.sources?.[id]?.fetched_at ?? ""));
  if (!timestamps.length || timestamps.some((time) => !Number.isFinite(time))) return "missing";
  return timestamps.some((time) => time < cutoff) ? "stale" : "fresh";
}

export async function preflightCommand(config: Config, args: string[]): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    process.stderr.write("[ask-agent] error: usage: ask-agent preflight [--json]\n");
    return 2;
  }
  const enabled = Object.entries(config.agents).filter(([, agent]) => agent.enabled === true);
  const [catalog, versions] = await Promise.all([
    buildCatalog(config, { refresh: true, concurrent: true }).catch((error: unknown) => {
      process.stderr.write(`[ask-agent] error: could not refresh catalog: ${String(error)}\n`);
      return null;
    }),
    Promise.all(enabled.map(([, agent]) => versionReport(agent))),
  ]);
  const entries = enabled.map(([id], i) => {
    const models = { usable: 0, unavailable: 0, out_of_quota: 0, unverified: 0 };
    let quota: number | null = null;
    for (const model of catalog?.agents[id]?.models ?? []) {
      models[model.status]++;
      if (model.quota_left !== undefined) quota = Math.min(quota ?? 1, model.quota_left);
    }
    return [id, { version: versions[i], quota, models }] as const;
  });
  const benchmarks = benchmarkStatus(config.benchmarks);
  const failed = !catalog || !Object.values(catalog.agents).some((agent) => agent.source === "cli" || agent.models.length);
  const outdated = benchmarks === "stale" || benchmarks === "missing" || versions.some(({ status }) => status === "outdated");
  if (args[0] === "--json") {
    process.stdout.write(`${JSON.stringify({ agents: Object.fromEntries(entries), benchmarks }, null, 2)}\n`);
  } else {
    const lines: string[] = [];
    for (const [id, { version, quota, models }] of entries) {
      const { installed, latest, status, update_cmd } = version;
      lines.push(`${id}  version ${installed ?? "unknown"} (latest ${latest ?? "unknown"}, ${status})`);
      lines.push(`  models: ${Object.entries(models).map(([status, count]) => `${count} ${status}`).join(", ")}`);
      if (quota !== null) lines.push(`  quota: ${Math.round(quota * 100)}%`);
      if (status === "outdated" && update_cmd) lines.push(`  update: ${update_cmd}`);
    }
    lines.push(`benchmarks: ${benchmarks}`, `preflight: ${failed ? "failed" : outdated ? "outdated" : "ready"}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return failed ? 1 : outdated ? 3 : 0;
}
