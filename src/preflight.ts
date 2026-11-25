import { execFile, spawn } from "node:child_process";
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

// Runs one update command through the shell. Its output goes to stderr so --json stdout stays parseable.
function runUpdate(command: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { stdio: ["ignore", 2, 2], timeout: 600_000, killSignal: "SIGKILL" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// Updates outdated agents one at a time: package managers share global state and must not race.
async function updateOutdated(enabled: Array<[string, Agent]>) {
  const versions = await Promise.all(enabled.map(([, agent]) => versionReport(agent)));
  const updates: Record<string, { command: string; exit: number }> = {};
  for (const [i, [id]] of enabled.entries()) {
    const { status, update_cmd } = versions[i];
    if (status !== "outdated") continue;
    if (!update_cmd) {
      process.stderr.write(`[ask-agent] ${id} is outdated but has no update_cmd\n`);
      continue;
    }
    process.stderr.write(`[ask-agent] updating ${id}: ${update_cmd}\n`);
    const exit = await runUpdate(update_cmd);
    process.stderr.write(exit === 0 ? `[ask-agent] updated ${id}\n` : `[ask-agent] update of ${id} failed (exit ${exit})\n`);
    updates[id] = { command: update_cmd, exit };
  }
  return updates;
}

export async function preflightCommand(config: Config, args: string[]): Promise<number> {
  const json = args.includes("--json");
  const update = args.includes("--update");
  if (args.length !== Number(json) + Number(update)) {
    process.stderr.write("[ask-agent] error: usage: ask-agent preflight [--json] [--update]\n");
    return 2;
  }
  const enabled = Object.entries(config.agents).filter(([, agent]) => agent.enabled === true);
  const updates = update ? await updateOutdated(enabled) : null;
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
  if (json) {
    const report = { agents: Object.fromEntries(entries), benchmarks, ...(updates ? { updates } : {}) };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
