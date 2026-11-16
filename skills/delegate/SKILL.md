---
name: delegate
description: Delegate work to external agent CLIs (codex/pi, agy, opencode, gentle-shell) by role or tier through ask-agent. Trigger: second opinion, ask codex/agy/opencode/gentle-shell, use other agents, save Claude tokens, draft docs cheaply, parallel opinions, compare models.
---

# Delegate to external agents

Claude is the orchestrator. gentle-shell, agy and opencode are executors: they do the whole task, writing included, inside `-C DIR` and return a receipt (files written, commands run). codex is a read-only advisor. Easy, well-specified work goes to agy or opencode; work that needs real thinking goes to gentle-shell.

Client servers, OCI and databases: Claude or gentle-shell; agy read-only (report work), enforced by `~/.claude/hooks/agy/vce_guards_agy.py` in `~/.gemini/config/hooks.json` (same guards plus a read-only rule; denials logged to `~/.cache/vce-guards/agy.jsonl`). gentle-shell loads the same Claude Code guards (`~/.claude/hooks/pi-extension/vce-guards.js`, symlinked into `~/.gentle-shell/agent/extensions/`). When it reports `CONFIRMACION REQUERIDA`, relay it to the user and stop; only on an explicit yes, re-run it saying the user confirmed that exact command, so it retries with `HOOK_CONFIRMADO=1`.

Trust the receipt: check one thing (the file exists, or one command) and never reread, redo or rewrite the agent's work; that doubles the cost. The limits (stay inside the working directory, no push, publish, data deletion or remote servers) are enforced by instruction, not by sandbox. Delegate from a clean git tree and check `git status` afterwards. `ask-agent` refuses nested calls, so an agent cannot route back into another agent.

## Pick the role

Roles in `agents.json` name who does what, in order, with model and effort. When a role fits the task, call by role: `ask-agent-ts roles` lists them with readiness, and `ask-agent-ts -r ROLE -C "$PWD" "<prompt>"` runs the first ready agent of the role and falls through to the next on quota, timeout or failure. The `-r` call form uses `ask-agent-ts` until `ask-agent` on PATH points at the TypeScript router.

## Pick the tier

When no role fits, pick a tier or an agent.

| Tier | Agents (in order) | Use for | Never for |
|---|---|---|---|
| `think` | codex, agy | Architecture, hard bugs, independent second opinion | Trivial work |
| `execute` | agy, codex | Bounded, well-specified tasks, writing included | Client servers, secrets |
| `draft` | opencode, agy | Docs, summaries, changelogs, translations, boilerplate prose | Decisions, security, shipped code |
| explicit | gentle-shell | Work that needs real thinking, writing included (`-a gentle-shell`) | Trivial work |

If the task is small and you already have the context, do it yourself: delegation costs a round trip plus reading the answer.

## How to call

Subagents keep long answers out of your context: `codex-thinker` (think), `agy-worker` (execute), `opencode-docs` (the `docs` role).

Direct call, prompt on stdin:

```bash
ask-agent -t think -C "$PWD" <<'PROMPT'
<self-contained prompt>
PROMPT
```

- `-a codex|agy|opencode|gentle-shell` forces one agent; `-t` and `-a` are exclusive.
- `ask-agent parallel -t think "<prompt>"` (or `-a codex,agy`) asks every ready agent at once and prints one `### agent` section each. Use it for important decisions: compare the answers, then decide yourself.
- `ask-agent status` shows readiness and agy quota; `ask-agent reset [agent]` clears cooldowns.

## Write the prompt

External agents share nothing with this session. Every prompt states the goal, constraints, acceptance criteria, and the exact file paths to read. Ask for a short answer, a unified diff, or a list, so reading it back stays cheap.

## Verify before using

- `draft`: read it and fix it before it lands anywhere.
- `execute`: check every file path, API and behaviour it asserts against the code before applying anything. You apply the change, never the agent.
- `think`: weigh it as one opinion. Disagreements between agents are signal; resolve them with evidence from the repo.

## Failures

`ask-agent` skips disabled, cooled-down or low-quota agents and falls back within the tier. When every agent fails, report the `[ask-agent]` error lines and continue the work yourself.
