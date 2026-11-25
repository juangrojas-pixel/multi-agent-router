import { spawnSync } from "node:child_process";
import type { Agent, Config } from "./config.ts";
import { agyUsage } from "./run.ts";
import { readCache, writeCache } from "./state.ts";

type Model = {
  id: string;
  status: "usable" | "unavailable" | "out_of_quota" | "unverified";
  reason?: string;
  quota_group?: string;
  quota_left?: number;
};
type AgentCatalog = { fetched_at: string; source: "cli" | "config"; models: Model[] };
type Catalog = { agents: Record<string, AgentCatalog> };
const cacheName = "catalog.json";
const usage = "usage: ask-agent catalog [-a AGENT] [--refresh] [--json]";

function listModels(list: Agent["list_models"]): Set<string> | null {
  if (!list) return null;
  const [command, ...args] = list.cmd;
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: (list.timeout_seconds ?? 60) * 1000,
  });
  if (result.error || result.status !== 0) return null;
  const ids = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (list.parse === "tsv") {
      const id = line.split("\t", 1)[0].trim();
      if (id) ids.add(id);
    } else if (list.parse === "pi-table") {
      // `pi --list-models`: "provider  model  context ..." rows; the id pi takes is provider/model.
      const [provider, model, context] = line.trim().split(/\s+/);
      if (!provider || !model || provider === "provider" || !/^[0-9]+[KM]?$/i.test(context ?? "")) continue;
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

function fetchAgent(id: string, agent: Agent): AgentCatalog {
  const listed = listModels(agent.list_models);
  const patterns = Object.entries(agent.quota_groups ?? {}).map(([glob, group]) => ({
    pattern: new RegExp(`^${glob.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`),
    group,
  }));
  const fractions = id === "agy" && patterns.length ? quotaByGroup(agent.command) : new Map<string, number>();
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

function render(catalog: Catalog): string {
  const lines: string[] = [];
  for (const [id, agent] of Object.entries(catalog.agents)) {
    lines.push(`${id}  (listed ${agent.fetched_at.slice(0, 16).replace("T", " ")}, ${agent.source})`);
    for (const model of agent.models) {
      const quota = model.quota_left === undefined ? "" : `  quota ${Math.round(model.quota_left * 100)}% (${model.quota_group})`;
      lines.push(`  ${model.status.padEnd(12)}  ${model.id}${quota}${model.reason ? `  (${model.reason})` : ""}`);
    }
  }
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
  const agents = Object.entries(config.agents).filter(([id, agent]) => agent.enabled === true && (!selected || selected === id));
  const cached = readCache<Catalog>(cacheName)?.agents;
  const entries: [string, AgentCatalog][] = [];
  for (const [id, agent] of agents) {
    if (refresh || !cached) entries.push([id, fetchAgent(id, agent)]);
    else if (Object.hasOwn(cached, id)) entries.push([id, cached[id]]);
  }
  const result: Catalog = { agents: Object.fromEntries(entries) };
  if (refresh || !cached) {
    writeCache(cacheName, selected ? { agents: { ...cached, ...result.agents } } : result);
  }
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
  return 0;
}
