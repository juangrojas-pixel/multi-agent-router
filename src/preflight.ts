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

type UpdateResult = { command: string; exit: number; timed_out?: true };

// Runs one update command through the shell, in its own process group so a timeout or Ctrl-C
// kills every process it started, not only `sh`. Output goes to stderr so --json stdout stays parseable.
function runUpdate(command: string, timeoutMs: number): Promise<UpdateResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { stdio: ["ignore", 2, 2], detached: true });
    const killGroup = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    const onSignal = () => { killGroup(); process.exit(130); };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    process.once("SIGINT", onSignal).once("SIGTERM", onSignal);
    const done = (exit: number) => {
      clearTimeout(timer);
      process.off("SIGINT", onSignal).off("SIGTERM", onSignal);
      resolve(timedOut ? { command, exit: 124, timed_out: true } : { command, exit });
    };
    child.on("error", () => done(127));
    child.on("close", (code) => done(code ?? 1));
  });
}

// Updates outdated agents one at a time: package managers share global state and must not race.
async function updateOutdated(enabled: Array<[string, Agent]>) {
  // ASK_AGENT_UPDATE_TIMEOUT_MS exists for tests; real updates get 10 minutes each.
  const timeoutMs = Number(process.env.ASK_AGENT_UPDATE_TIMEOUT_MS) || 600_000;
  const versions = await Promise.all(enabled.map(([, agent]) => versionReport(agent)));
  const updates: Record<string, UpdateResult> = {};
  for (const [i, [id]] of enabled.entries()) {
    const { status, update_cmd } = versions[i];
    if (status !== "outdated") continue;
    if (!update_cmd) {
      process.stderr.write(`[ask-agent] ${id} is outdated but has no update_cmd\n`);
      continue;
    }
    process.stderr.write(`[ask-agent] updating ${id}: ${update_cmd}\n`);
    const result = await runUpdate(update_cmd, timeoutMs);
    process.stderr.write(result.timed_out ? `[ask-agent] update of ${id} timed out after ${timeoutMs / 1000} s\n`
      : result.exit === 0 ? `[ask-agent] updated ${id}\n` : `[ask-agent] update of ${id} failed (exit ${result.exit})\n`);
    updates[id] = result;
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
  const updateFailed = Object.values(updates ?? {}).some(({ exit }) => exit !== 0);
  const outdated = updateFailed || benchmarks === "stale" || benchmarks === "missing" || versions.some(({ status }) => status === "outdated");
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
