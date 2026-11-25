import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Agent = {
  enabled?: boolean; command: string; model?: string | null; timeout_seconds?: number;
  extra_args?: string[]; prompt_preamble?: string; fallback?: string[]; quota?: { group: string; min_remaining: number };
  args?: string[]; model_args?: string[]; effort_args?: string[];
  models?: string[]; effort_levels?: string[];
  output?: "text" | "agy-json" | "opencode-events";
  backend?: string;
};
// A role entry is an agent id, or an agent id with its own model and effort.
export type RoleAgent = string | { agent: string; model?: string; effort?: string };
export type Role = { description: string; agents: RoleAgent[]; model?: string; effort?: string; prompt_preamble?: string };
export type Config = {
  cooldown_seconds?: number; default_tier?: string; tiers?: Record<string, string[]>; agents: Record<string, Agent>;
  roles?: Record<string, Role>; orchestrator?: { agent: string }; routing?: { notes?: string; general?: string; rules?: Array<{ role?: string }> };
  prompt_preamble?: string; backend?: string;
};

const outputs = ["text", "agy-json", "opencode-events"];

// Checks the rules of data-model.md and returns the first mistake as "KEY: MESSAGE", or null.
export function validateConfig(config: Config): string | null {
  const agents = config.agents ?? {};
  for (const [id, agent] of Object.entries(agents)) {
    if (agent.output !== undefined && !outputs.includes(agent.output)) {
      return `agents.${id}.output: unknown output: ${agent.output} (use text, agy-json or opencode-events)`;
    }
  }
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
