import type { Config } from "./config.ts";
import { available, runAgent } from "./run.ts";

export type RoleEntry = { agent: string; model: string; effort: string };

// Resolves a role to its entries in order, dropping repeated agents.
// The entry's own model and effort win over the role default, which wins over the agent's model.
export function resolveRole(config: Config, name: string): RoleEntry[] {
  const roles = config.roles ?? {};
  const names = Object.keys(roles);
  if (names.length === 0) throw new Error("no roles configured");
  const role = roles[name];
  if (!role) throw new Error(`unknown role: ${name} (configured: ${names.join(", ")})`);
  const entries: RoleEntry[] = [];
  for (const item of role.agents) {
    const entry = typeof item === "string" ? { agent: item } : item;
    if (entries.some((seen) => seen.agent === entry.agent)) continue;
    entries.push({
      agent: entry.agent,
      model: entry.model ?? role.model ?? config.agents[entry.agent]?.model ?? "",
      effort: entry.effort ?? role.effort ?? "",
    });
  }
  return entries;
}

// Runs a role's entries in order: skips unavailable ones, falls through on any failure,
// and names each step on stderr. Per-agent `fallback` lists are not used here.
export async function runRole(config: Config, name: string, entries: RoleEntry[], prompt: string): Promise<boolean> {
  const log = (message: string) => process.stderr.write(`[ask-agent] role ${name}: ${message}\n`);
  for (const [index, entry] of entries.entries()) {
    let reason = available(entry.agent, config);
    if (reason?.startsWith("command not found")) reason = "not installed";
    if (!reason) {
      process.stderr.write(`[ask-agent] using ${entry.agent}\n`);
      const result = await runAgent(entry.agent, config, prompt, entry.model, "", entry.effort, name);
      if (result.ok) return true;
      reason = result.reason;
    }
    const next = entries[index + 1];
    log(next ? `${entry.agent} failed (${reason}), trying ${next.agent}` : `${entry.agent} failed (${reason})`);
  }
  log("no agent could run");
  return false;
}
