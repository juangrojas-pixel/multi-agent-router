# multi-agent-router

Claude Code plugin that lets Claude orchestrate other agent CLIs by tier, quota-aware.
Executors (gentle-shell, agy, opencode) do the whole task, writing included, inside `-C DIR` and return a receipt; codex is a read-only advisor. gentle-shell (besides Claude) works on client servers under the same guards as Claude (`~/.claude/hooks/pi-extension`); agy only read-only, enforced by a hook (`~/.claude/hooks/agy`). agy and opencode take easy, well-specified work; gentle-shell takes work that needs real thinking.

| Tier | Agents | Use for |
|---|---|---|
| `think` | codex (bare pi, GPT via ChatGPT), agy | Architecture, hard bugs, second opinions |
| `execute` | agy, codex | Bounded tasks, reviews, proposed diffs (verified by Claude) |
| `draft` | opencode (free model, build agent), agy | Docs, summaries, boilerplate |
| explicit | gentle-shell | Only with `-a gentle-shell` |

## Pieces

- `bin/ask-agent`: router. Refuses nested calls (`ASK_AGENT_DEPTH`), prepends a `prompt_preamble` to every prompt: the agent's own (executor) or the global read-only one (advisor). Tier fallback, agy quota check via `agy -p /usage` (0 tokens), reactive quota-error cooldown, per-agent timeout that kills the whole process group.
- `agents.json`: tiers, models, timeouts, quota threshold, enabled flags, and `routing` (the single routing policy: general text, directive template, ordered rules; inline rules first, first match wins).
- `bin/route-hint`: `UserPromptSubmit` hook. Matches the prompt against `routing.rules` and injects a concrete `ROUTE NOW ... ask-agent -a <agent>` directive, nothing for inline rules, or the general policy when no rule matches. When the matched agent is in cooldown (out of quota, from `ask-agent`'s `cooldown.json`), it injects a `SKIP DELEGATION` note instead, until the cooldown expires. Logs each decision to `~/.cache/multi-agent-router/route.jsonl` (rule, agent, prompt length; never the prompt text). `route-hint --stats` counts decisions per rule. Rule order (first match wins): `inline-explicit`, `explicit-delegate` (user asks for agents, even on client work), `inline-sensitive` (secrets, restarts, opening ports), `report-doc` and `client-text` (agy), `client-work` (gentle-shell), then `second-opinion`, `design`, `docs`, `spec`. Client work hands context over through engram: the caller saves `topic_key=handoff/actual` in the client's project and the agent reads it with `mem_search`; agy, gentle-shell, codex and opencode share `~/.engram/engram.db`. Tests: `tests/route-hint.test.sh`, `tests/ask-agent.test.sh`.
- `agents/`: subagents `codex-thinker`, `agy-worker`, `opencode-docs`.
- `skills/delegate`: tier policy and how to delegate.
- `hooks/register.ts`: checks readiness at session start (status line) and injects a short frame, `routing.general` and readiness into the system prompt.

## Usage

```bash
ask-agent status
ask-agent -t think "question"            # first ready agent in the tier
ask-agent -a opencode "draft a README"   # force one agent
ask-agent parallel -t think "question"   # every ready agent, one section each
ask-agent reset [agent]                  # clear cooldowns
```

## Install (local)

```bash
ln -sf "$PWD/bin/ask-agent" ~/.local/bin/ask-agent
claude plugin marketplace add "$PWD"
claude plugin install multi-agent-router@multi-agent-router
```

Then `/reload-plugins` in a running session. Requires `jq`, `perl`, and the agent CLIs (`pi`, `agy`, `opencode`, `gentle-shell`).
