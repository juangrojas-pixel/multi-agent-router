import type { Config } from "./config.ts";

// The command the guidance tells the orchestrator to run. It stays `ask-agent-ts` until the
// switch in phase 8 points `ask-agent` on PATH at this router (user decision, 2026-11-16).
export const ROUTER_CALL = "ask-agent-ts";

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
  const notes = config.routing?.notes?.trim();
  if (notes) parts.push(notes);
  return parts.length > 0 ? `${parts.join("\n\n")}\n` : "";
}
