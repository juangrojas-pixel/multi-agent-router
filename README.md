# multi-agent-router

Claude Code plugin that lets Claude orchestrate other agent CLIs by tier, quota-aware.
Claude stays the only writer; external agents are read-only advisors.

| Tier | Agents | Use for |
|---|---|---|
| `think` | codex (bare pi, GPT via ChatGPT), agy | Architecture, hard bugs, second opinions |
| `execute` | agy, codex | Bounded tasks, reviews, proposed diffs (verified by Claude) |
| `draft` | opencode (free model, plan agent), agy | Docs, summaries, boilerplate |
| explicit | gentle-shell | Only with `-a gentle-shell` |

## Pieces

- `bin/ask-agent`: router. Refuses nested calls (`ASK_AGENT_DEPTH`), prepends a read-only `prompt_preamble` to every prompt. Tier fallback, agy quota check via `agy -p /usage` (0 tokens), reactive quota-error cooldown, per-agent timeout that kills the whole process group.
- `agents.json`: tiers, models, timeouts, quota threshold, enabled flags.
- `agents/`: subagents `codex-thinker`, `agy-worker`, `opencode-docs`.
- `skills/delegate`: tier policy and how to delegate.
- `hooks/register.ts`: checks readiness at session start (status line) and injects the policy plus readiness into the system prompt.

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
