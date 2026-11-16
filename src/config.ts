import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Agent = {
  enabled?: boolean; command: string; model?: string | null; timeout_seconds?: number;
  extra_args?: string[]; prompt_preamble?: string; fallback?: string[]; quota?: { group: string; min_remaining: number };
  args?: string[]; model_args?: string[]; effort_args?: string[];
  output?: "text" | "agy-json" | "opencode-events";
  backend?: string;
};
// A role entry is an agent id, or an agent id with its own model and effort.
export type RoleAgent = string | { agent: string; model?: string; effort?: string };
export type Role = { description: string; agents: RoleAgent[]; model?: string; effort?: string };
export type Config = { cooldown_seconds?: number; default_tier?: string; tiers?: Record<string, string[]>; agents: Record<string, Agent>; roles?: Record<string, Role>; prompt_preamble?: string; backend?: string };

export function configPath(): string { return process.env.ASK_AGENT_CONFIG || resolve(import.meta.dirname, "../agents.json"); }
export function loadConfig(): Config {
  const path = configPath();
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
  try { return JSON.parse(text) as Config; } catch (error) { throw new Error(`${path}: ${(error as Error).message}`); }
}
