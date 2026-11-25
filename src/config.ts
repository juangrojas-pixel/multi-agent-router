import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Agent = {
  enabled?: boolean; command: string; model?: string | null; timeout_seconds?: number;
  extra_args?: string[]; prompt_preamble?: string; fallback?: string[]; quota?: { group: string; min_remaining: number };
  args?: string[]; model_args?: string[]; effort_args?: string[];
  models?: string[]; effort_levels?: string[];
  output?: "text" | "agy-json" | "opencode-events";
  backend?: string;
  // Agentic dispatcher (specs/002-agentic-dispatcher/data-model.md).
  list_models?: { cmd: string[]; parse: string; timeout_seconds?: number };
  version_cmd?: string[]; latest_cmd?: string[] | null; update_cmd?: string;
  quota_groups?: Record<string, string>; shares_quota_with?: string;
};
// A role entry is an agent id, or an agent id with its own model and effort.
export type RoleAgent = string | { agent: string; model?: string; effort?: string };
export type Role = { description: string; agents: RoleAgent[]; model?: string; effort?: string; prompt_preamble?: string };
export type Config = {
  cooldown_seconds?: number; default_tier?: string; tiers?: Record<string, string[]>; agents: Record<string, Agent>;
  roles?: Record<string, Role>; orchestrator?: { agent: string }; routing?: { notes?: string; general?: string; rules?: Array<{ role?: string }> };
  prompt_preamble?: string; backend?: string;
  capability_tiers?: string[]; kinds?: string[]; sizes?: Record<string, number>; cost_ceiling?: number;
  dispatch?: { concurrency?: number }; models?: Record<string, { tier?: Record<string, string> }>;
  model_aliases?: Record<string, string>;
  benchmarks?: { max_age_days?: number; sources?: Array<{ id: string; url: string; parse: string }> };
};

const outputs = ["text", "agy-json", "opencode-events"];
export const listParsers = ["tsv", "lines-first-field", "pi-table"];
export const benchmarkParsers = ["models-dev", "lmarena-hf", "openrouter", "artificial-analysis"];

function badCommand(cmd: unknown): boolean {
  return !Array.isArray(cmd) || typeof cmd[0] !== "string" || cmd[0] === "";
}

// Checks the rules of data-model.md and returns the first mistake as "KEY: MESSAGE", or null.
export function validateConfig(config: Config): string | null {
  const agents = config.agents ?? {};
  for (const [id, agent] of Object.entries(agents)) {
    if (agent.output !== undefined && !outputs.includes(agent.output)) {
      return `agents.${id}.output: unknown output: ${agent.output} (use text, agy-json or opencode-events)`;
    }
    if (agent.list_models) {
      if (badCommand(agent.list_models.cmd)) return `agents.${id}.list_models.cmd: must start with a non-empty command`;
      if (!listParsers.includes(agent.list_models.parse)) {
        return `agents.${id}.list_models.parse: unknown parser: ${agent.list_models.parse} (use tsv, lines-first-field or pi-table)`;
      }
    }
    if (agent.version_cmd !== undefined && badCommand(agent.version_cmd)) return `agents.${id}.version_cmd: must start with a non-empty command`;
  }
  const dispatcher = validateDispatcher(config);
  if (dispatcher) return dispatcher;
  for (const [name, role] of Object.entries(config.roles ?? {})) {
    if (!role.agents?.length) return `roles.${name}.agents: role has no agents`;
    for (const [index, item] of role.agents.entries()) {
      const key = `roles.${name}.agents[${index}]`;
      const entry = typeof item === "string" ? { agent: item } : item;
      const agent = agents[entry.agent];
      if (!agent) return `${key}: unknown agent: ${entry.agent}`;
      const model = entry.model ?? role.model;
      if (model && agent.models && !agent.models.includes(model)) return `${key}: model ${model} is not in agents.${entry.agent}.models`;
      const effort = entry.effort ?? role.effort;
      if (effort && !agent.effort_levels?.length) return `${key}: agent ${entry.agent} has no effort_levels`;
      if (effort && !agent.effort_levels!.includes(effort)) return `${key}: effort ${effort} is not in agents.${entry.agent}.effort_levels`;
    }
  }
  if (config.orchestrator && !agents[config.orchestrator.agent]) return `orchestrator.agent: unknown agent: ${config.orchestrator.agent}`;
  for (const [index, rule] of (config.routing?.rules ?? []).entries()) {
    if (rule.role !== undefined && !config.roles?.[rule.role]) return `routing.rules[${index}].role: unknown role: ${rule.role}`;
  }
  return null;
}

function validateDispatcher(config: Config): string | null {
  const tiers = config.capability_tiers;
  if (tiers !== undefined && (!Array.isArray(tiers) || tiers.length === 0 || new Set(tiers).size !== tiers.length)) {
    return "capability_tiers: must be a non-empty list of unique names";
  }
  for (const [model, facts] of Object.entries(config.models ?? {})) {
    for (const [kind, tier] of Object.entries(facts.tier ?? {})) {
      if (!config.kinds?.includes(kind)) return `models.${model}.tier.${kind}: unknown kind: ${kind}`;
      if (!tiers?.includes(tier)) return `models.${model}.tier.${kind}: unknown tier: ${tier}`;
    }
  }
  for (const [size, tokens] of Object.entries(config.sizes ?? {})) {
    if (!Number.isInteger(tokens) || tokens <= 0) return `sizes.${size}: must be a positive integer`;
  }
  if (config.cost_ceiling !== undefined && !(typeof config.cost_ceiling === "number" && config.cost_ceiling > 0)) {
    return "cost_ceiling: must be greater than 0";
  }
  const concurrency = config.dispatch?.concurrency;
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1)) return "dispatch.concurrency: must be an integer >= 1";
  for (const [index, source] of (config.benchmarks?.sources ?? []).entries()) {
    if (!benchmarkParsers.includes(source.parse)) {
      return `benchmarks.sources[${index}].parse: unknown parser: ${source.parse} (use models-dev, lmarena-hf, openrouter or artificial-analysis)`;
    }
  }
  return null;
}

// The private policy file: site text kept outside the repository, merged over agents.json.
export function policyPath(): string {
  if (process.env.ASK_AGENT_POLICY) return process.env.ASK_AGENT_POLICY;
  const base = process.env.XDG_CONFIG_HOME || join(process.env.HOME || "/tmp", ".config");
  return join(base, "multi-agent-router", "policy.json");
}

// Reads the private policy file; null when it does not exist. Errors name the file.
export function loadPolicy(): { path: string; data: Record<string, unknown> } | null {
  const path = policyPath();
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
  if (!isObject(data)) throw new Error(`${path}: not a JSON object`);
  return { path, data };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Objects merge key by key; scalars and arrays from `over` replace those of `base`.
export function mergeConfig<T>(base: T, over: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(over)) {
    out[key] = isObject(value) && isObject(out[key]) ? mergeConfig(out[key], value) : value;
  }
  return out as T;
}

export function configPath(): string { return process.env.ASK_AGENT_CONFIG || resolve(import.meta.dirname, "../agents.json"); }
export function loadConfig(): Config {
  const path = configPath();
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
  try { return JSON.parse(text) as Config; } catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
}
