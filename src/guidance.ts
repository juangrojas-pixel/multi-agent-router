import type { Config } from "./config.ts";

// The command the guidance tells the orchestrator to run: `ask-agent` on PATH is this router
// since the switch of phase 8 (T037, 2026-11-16).
export const ROUTER_CALL = "ask-agent";

// Routing guidance for whichever agent orchestrates: one line per role, then routing.notes.
// It names no orchestrating product, so every adapter delivers the same text.
export function guidance(config: Config): string {
  const parts: string[] = [];
  const roles = Object.entries(config.roles ?? {});
  if (roles.length > 0) {
    parts.push([
      "Delegate by role through the router. Each line is a role, what it is for, and the call to make:",
      ...roles.map(([name, role]) => `- ${name}: ${role.description} Call: \`${ROUTER_CALL} -r ${name} -C <dir> "<task>"\``),
    ].join("\n"));
  }
  // The per-task choice (specs/002-agentic-dispatcher): shown only when the capability vocabulary
  // is configured, so a router without it keeps its role-only guidance.
  const tiers = config.capability_tiers ?? [];
  const kinds = config.kinds ?? [];
  if (tiers.length > 0 && kinds.length > 0) {
    const sizes = Object.keys(config.sizes ?? { s: 0, m: 0, l: 0 });
    parts.push([
      "Choose agent and model per task with evidence (roles stay the default):",
      `1. Before a plan: \`${ROUTER_CALL} preflight\` (versions, quotas, usable models).`,
      `2. Per task: \`${ROUTER_CALL} candidates --kind <${kinds.join("|")}> --tier <${tiers.join("|")}> --size <${sizes.join("|")}>\` lists capable agent/model pairs, cheapest first. Pick the cheapest that is good enough.`,
      `3. Run it and record why: \`${ROUTER_CALL} -a <agent> -m <model> --task <id> --reason "<why>" -C <dir> "<task>"\`.`,
      `4. Distinct tasks at the same time: \`${ROUTER_CALL} dispatch -f <batch.json>\`, one receipt per task.`,
      "5. Client servers, cloud or databases: only agents allowed for client work (`candidates --client`).",
    ].join("\n"));
  }
  const notes = config.routing?.notes?.trim();
  if (notes) parts.push(notes);
  return parts.length > 0 ? `${parts.join("\n\n")}\n` : "";
}
