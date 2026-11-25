---
name: delegate
description: Delegate work to external agent CLIs (codex/pi, agy, opencode, gentle-shell) by role or tier through ask-agent. Trigger: second opinion, ask codex/agy/opencode/gentle-shell, use other agents, save Claude tokens, draft docs cheaply, parallel opinions, compare models.
---

# Delegate to external agents

Claude is the orchestrator. gentle-shell, agy and opencode are executors: they do the whole task, writing included, inside `-C DIR` and return a receipt (files written, commands run). codex is a read-only advisor. Easy, well-specified work goes to agy or opencode; work that needs real thinking goes to gentle-shell.

Client servers, OCI and databases: Claude or gentle-shell; agy read-only (report work), enforced by `~/.claude/hooks/agy/vce_guards_agy.py` in `~/.gemini/config/hooks.json` (same guards plus a read-only rule; denials logged to `~/.cache/vce-guards/agy.jsonl`). gentle-shell loads the same Claude Code guards (`~/.claude/hooks/pi-extension/vce-guards.js`, symlinked into `~/.gentle-shell/agent/extensions/`). When it reports `CONFIRMACION REQUERIDA`, relay it to the user and stop; only on an explicit yes, re-run it saying the user confirmed that exact command, so it retries with `HOOK_CONFIRMADO=1`.

Trust the receipt: check one thing (the file exists, or one command) and never reread, redo or rewrite the agent's work; that doubles the cost. The limits (stay inside the working directory, no push, publish, data deletion or remote servers) are enforced by instruction, not by sandbox. Delegate from a clean git tree and check `git status` afterwards. `ask-agent` refuses nested calls, so an agent cannot route back into another agent.

## Plan with agent and model per task (ODD)

When an ODD plan has several tasks, choose agent and model for each one with evidence instead of sending everything to one agent:

1. Before the plan: `ask-agent preflight`. It reports outdated CLIs (with their update command), quotas and usable models; it never updates anything.
2. Per task, name its kind (`code`, `reasoning`, `writing`, `review`), the tier it needs (`light` < `standard` < `strong` < `frontier`) and its size (`s`, `m`, `l`), then run `ask-agent candidates --kind K --tier T --size S`. Pick the cheapest candidate that is good enough; `!` lines exceed the cost ceiling. `ask-agent catalog` shows every usable model with its tiers (`*` = declared in config, not measured) and price.
3. Write the choice in the task line of the feature document (`T2 -> agy/gemini-4-neon-high: frontier for code, Gemini quota 96%`) and run it with `ask-agent -a AGENT -m MODEL --task T2 --reason "<why>" -C "$PWD" "<prompt>"`, so `runs.jsonl` keeps who ran it, with which model and why.
4. Independent tasks with disjoint files run together: `ask-agent dispatch -f batch.json` (one receipt per task, `dispatch.concurrency` at a time). Free text work (docs) goes to opencode at cost 0.
5. Inside the Herdr app (an hc terminal), delegated agents appear under the orchestrator automatically. `--backend live` runs one in its interactive TUI so the user can watch and steer it.

Claude models run two ways: the `claude` agent (`-m haiku|sonnet|opus`, shares the orchestrator's quota) or agy's `claude-opus-5-5` / `claude-sonnet-5-5` (agy's own quota). Models the account cannot use (for example Fable 5.2) fail that run without cooling the agent down.

## Pick the role

Roles in `agents.json` name who does what, in order, with model and effort. When a role fits the task, call by role: `ask-agent roles` lists them with readiness, and `ask-agent -r ROLE -C "$PWD" "<prompt>"` runs the first ready agent of the role and falls through to the next on quota, timeout or failure.

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
