import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { Agent, Config } from "./config.ts";
import { benchmarkCache, profileFor, refreshBenchmarks, type BenchmarkProfile, type BenchmarkCache } from "./benchmarks.ts";
import { agyUsage } from "./run.ts";
import { readCache, writeCache } from "./state.ts";

type Model = {
  id: string;
  status: "usable" | "unavailable" | "out_of_quota" | "unverified";
  reason?: string;
  quota_group?: string;
  quota_left?: number;
  profile?: BenchmarkProfile | null;
};
type AgentCatalog = { fetched_at: string; source: "cli" | "config"; models: Model[] };
type Catalog = { agents: Record<string, AgentCatalog> };
const exec = promisify(execFile);
const cacheName = "catalog.json";
const usage = "usage: ask-agent catalog [-a AGENT] [--refresh] [--json]";

// Honor the configured timeout (default 60s, SIGKILL) without a lower preflight cap so slow
// agents (e.g. gentle-shell at 120s) are not cut short.
async function listModels(list: Agent["list_models"]): Promise<Set<string> | null> {
  if (!list) return null;
  const [command, ...args] = list.cmd;
  try {
    const { stdout } = await exec(command, args, {
      encoding: "utf8", timeout: (list.timeout_seconds ?? 60) * 1000, killSignal: "SIGKILL",
    });
    // An empty listing is a failure, not an agent without models: caching it would hide every model.
    const ids = parseModels(stdout, list.parse);
    return ids.size ? ids : null;
  } catch {
    return null;
  }
}

function parseModels(stdout: string, parse: string): Set<string> {
  const ids = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (parse === "tsv") {
      const id = line.split("\t", 1)[0].trim();
      if (id) ids.add(id);
    } else if (parse === "pi-table") {
      // `pi --list-models`: "provider  model  context ..." rows; the id pi takes is provider/model.
      const [provider, model, context] = line.trim().split(/\s+/);
      if (!provider || !model || provider === "provider" || !/^[0-9]+(\.[0-9]+)?[KM]?$/i.test(context ?? "")) continue;
      ids.add(`${provider}/${model}`);
    } else {
      const [id, ...columns] = line.trim().split(/\s+/);
      if (!/^[a-z0-9][a-z0-9._/:@-]*$/i.test(id)) continue;
      // Bare IDs can appear alone; table rows need a first field that looks like an ID, not a heading word.
      if (columns.length && !/[0-9._/:@-]/.test(id)) continue;
      ids.add(id);
    }
  }
  return ids;
}

function quotaByGroup(command: string): Map<string, number> {
  const fractions = new Map<string, number>();
  const report = agyUsage(command);
  if (report.status !== 0) return fractions;
  try {
    const groups = JSON.parse(report.stdout)?.command?.data?.groups;
    if (!Array.isArray(groups)) return fractions;
    for (const group of groups) {
      if (typeof group?.name !== "string" || !Array.isArray(group.buckets)) continue;
      for (const bucket of group.buckets) {
        const left = bucket?.remaining_fraction;
        if (typeof left === "number" && left >= 0 && left <= 1) {
          fractions.set(group.name, Math.min(fractions.get(group.name) ?? 1, left));
        }
      }
    }
  } catch {
    // An unreadable usage report leaves quota unknown, not exhausted.
  }
  return fractions;
}

// Keep the existing synchronous quota reader off the event loop during preflight.
if (!isMainThread && typeof workerData?.catalogQuotaCommand === "string") {
  parentPort!.postMessage(quotaByGroup(workerData.catalogQuotaCommand));
}

function fetchQuota(command: string): Promise<Map<string, number>> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { catalogQuotaCommand: command } });
    worker.once("message", resolve);
    // A crashed worker leaves quota unknown for this agent instead of failing the whole catalog.
    worker.once("error", () => resolve(new Map()));
    worker.once("exit", () => resolve(new Map()));
  });
}

async function fetchAgent(id: string, agent: Agent, concurrent: boolean): Promise<AgentCatalog> {
  const checkQuota = id === "agy" && Object.keys(agent.quota_groups ?? {}).length > 0;
  const [listed, fractions] = concurrent
    ? await Promise.all([listModels(agent.list_models), checkQuota ? fetchQuota(agent.command) : new Map<string, number>()])
    : [await listModels(agent.list_models), checkQuota ? await fetchQuota(agent.command) : new Map<string, number>()];
  const patterns = Object.entries(agent.quota_groups ?? {}).map(([glob, group]) => ({
    pattern: new RegExp(`^${glob.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`),
    group,
  }));
  const models = Array.from(new Set([...(listed ?? []), ...(agent.models ?? [])]), (modelId): Model => {
    const model: Model = { id: modelId, status: listed ? "usable" : "unverified" };
    if (listed && !listed.has(modelId)) {
      model.status = "unavailable";
      model.reason = `not listed by ${id}`;
    }
    const match = patterns.find(({ pattern }) => pattern.test(modelId));
    if (match) {
      model.quota_group = match.group;
      const left = fractions.get(match.group);
      if (left !== undefined) {
        model.quota_left = left;
        if (model.status === "usable" && agent.quota && left < agent.quota.min_remaining) {
          model.status = "out_of_quota";
        }
      }
    }
    return model;
  });
  return { fetched_at: new Date().toISOString(), source: listed ? "cli" : "config", models };
}

function render(catalog: Catalog, sources?: BenchmarkCache["sources"]): string {
  const lines: string[] = [];
  for (const [id, agent] of Object.entries(catalog.agents)) {
    lines.push(`${id}  (listed ${agent.fetched_at.slice(0, 16).replace("T", " ")}, ${agent.source})`);
    for (const model of agent.models) {
      const quota = model.quota_left === undefined ? "" : `  quota ${Math.round(model.quota_left * 100)}% (${model.quota_group})`;
      const profile = model.profile;
      const tiers = Object.entries(profile?.tier ?? {}).map(([kind, tier]) =>
        `  ${kind}=${tier}${profile?.tier_source[kind] === "declared" ? "*" : ""}`).join("");
      const price = profile?.price_out_per_m === undefined ? "" : `  $out/M=${profile.price_out_per_m}`;
      lines.push(`  ${model.status.padEnd(12)}  ${model.id}${tiers}${price}${quota}${model.reason ? `  (${model.reason})` : ""}`);
    }
  }
  if (sources) lines.push(`sources: ${Object.entries(sources).map(([id, entry]) =>
    `${id} ${entry.fetched_at?.slice(0, 10) ?? "-"} ${entry.status}`).join(", ")}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export async function catalogCommand(config: Config, args: string[]): Promise<number> {
  function error(message: string): number {
    process.stderr.write(`[ask-agent] error: ${message}\n`);
    return 2;
  }
  let selected: string | undefined;
  let refresh = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-a":
        selected = args[++i];
        if (!selected || selected.startsWith("-")) return error(usage);
        break;
      case "--refresh": refresh = true; break;
      case "--json": json = true; break;
      default: return error(usage);
    }
  }
  if (selected !== undefined && !Object.hasOwn(config.agents, selected)) return error(`unknown agent: ${selected}`);
  const [benchmarks, result] = config.benchmarks && refresh
    ? await Promise.all([refreshBenchmarks(config), buildCatalog(config, { refresh, agent: selected })])
    : [config.benchmarks ? benchmarkCache(config) : undefined, await buildCatalog(config, { refresh, agent: selected })];
  if (benchmarks) {
    for (const agent of Object.values(result.agents)) {
      for (const model of agent.models) model.profile = profileFor(config, benchmarks, model.id);
    }
  }
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : render(result, benchmarks?.sources));
  return 0;
}

export async function buildCatalog(config: Config, { refresh, agent: selected, concurrent = false, keepCached = false }: {
  refresh?: boolean; agent?: string; concurrent?: boolean; keepCached?: boolean;
} = {}): Promise<Catalog> {
  const agents = Object.entries(config.agents).filter(([id, agent]) => agent.enabled === true && (!selected || selected === id));
  const cached = readCache<Catalog>(cacheName)?.agents;
  const entries: [string, AgentCatalog][] = [];
  let updated = false;
  if (refresh || !cached) {
    const fetched: [string, AgentCatalog][] = concurrent
      ? await Promise.all(agents.map(async ([id, agent]): Promise<[string, AgentCatalog]> =>
        [id, await fetchAgent(id, agent, true)]))
      : [];
    if (!concurrent) {
      for (const [id, agent] of agents) fetched.push([id, await fetchAgent(id, agent, false)]);
    }
    for (const [id, entry] of fetched) {
      if (keepCached && entry.source !== "cli" && cached && Object.hasOwn(cached, id) && cached[id].source === "cli") {
        entries.push([id, cached[id]]);
      } else {
        entries.push([id, entry]);
        updated = true;
      }
    }
  } else {
    // Cached reads still query the CLI and update catalog.json for enabled agents missing from the cache.
    let added = false;
    for (const [id, agent] of agents) {
      if (Object.hasOwn(cached, id)) entries.push([id, cached[id]]);
      else { entries.push([id, await fetchAgent(id, agent, concurrent)]); added = true; }
    }
    if (added) writeCache(cacheName, { agents: { ...cached, ...Object.fromEntries(entries) } });
  }
  const result: Catalog = { agents: Object.fromEntries(entries) };
  if ((refresh || !cached) && (!keepCached || updated)) {
    writeCache(cacheName, selected ? { agents: { ...cached, ...result.agents } } : result);
  }
  return result;
}
