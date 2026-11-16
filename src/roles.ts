import type { Config } from "./config.ts";

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
