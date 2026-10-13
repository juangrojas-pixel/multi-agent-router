---
name: delegate
description: Delegate work to external agent CLIs (codex/pi, agy, opencode, gentle-shell) by tier through ask-agent. Trigger: second opinion, ask codex/agy/opencode/gentle-shell, use other agents, save Claude tokens, draft docs cheaply, parallel opinions, compare models.
---

# Delegate to external agents

Claude is the orchestrator and the only writer. External agents are read-only advisors whose output is evidence, not truth.

Read-only is enforced by instruction, not by sandbox: agy runs shell commands on its own in `-p` mode, and a thorough review can take 5 to 10 minutes. Delegate from a clean git tree and check `git status` afterwards. `ask-agent` refuses nested calls, so an agent cannot route back into another agent.

## Pick the tier

| Tier | Agents (in order) | Use for | Never for |
|---|---|---|---|
| `think` | codex, agy | Architecture, hard bugs, independent second opinion | Trivial work |
| `execute` | agy, codex | Bounded, well-specified tasks; reviews; proposed diffs | Unverified changes |
| `draft` | opencode, agy | Docs, summaries, changelogs, translations, boilerplate prose | Decisions, security, shipped code |
| explicit | gentle-shell | Only when the user asks for gentle-shell | Default routing |

If the task is small and you already have the context, do it yourself: delegation costs a round trip plus reading the answer.

## How to call

Subagents keep long answers out of your context: `codex-thinker` (think), `agy-worker` (execute), `opencode-docs` (draft).

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
