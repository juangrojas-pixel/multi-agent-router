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

- `bin/ask-agent`: router. Refuses nested calls (`ASK_AGENT_DEPTH`), prepends a `prompt_preamble` to every prompt: the agent's own (executor) or the global read-only one (advisor). Tier fallback, per-agent `fallback` for `-a` calls (opencode falls back to agy), agy quota check via `agy -p /usage` (0 tokens), reactive quota-error cooldown, per-agent timeout that kills the whole process group.
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
ask-agent --backend hc -a codex "question"   # run the agent in a live hc terminal
ask-agent runs [N] [-a agent]            # run history, last N (default 20)
bin/ask-agent-ts -r coder "task"         # run as a role (TypeScript router only)
```

### Roles

`roles` in `agents.json` names who does what. Each role has a `description`, an ordered `agents` list and optional `model` and `effort` defaults. An entry is an agent id or `{ "agent", "model", "effort" }`; the entry's own value wins over the role default, which wins over the agent's `model`. The effort reaches the agent through its `effort_args` (for example `["--thinking", "{effort}"]`); an agent without `effort_args` ignores it.

```json
"roles": {
  "coder": { "description": "Writes and edits code from a clear task.", "agents": ["gentle-shell", "agy"] },
  "docs": { "description": "Drafts low-stakes text.", "agents": ["opencode", { "agent": "agy", "model": "gemini-3-flash" }] }
}
```

`-r ROLE` (or `--role ROLE`) runs the task on the role's agents in order. An entry that is disabled, not installed or in cooldown is skipped; one that hits a quota error (which also sets its cooldown), times out, fails or answers nothing hands the task to the next. Each step prints `[ask-agent] role NAME: AGENT failed (REASON), trying NEXT` on stderr; when no entry can answer, the last line is `[ask-agent] role NAME: no agent could run` and the exit status is 2. Per-agent `fallback` lists apply to `-a` only, never to roles. It cannot be combined with `-a`, `-t` or `-m` (exit 2). An unknown role exits 2 with `unknown role: NAME (configured: ...)`; a config without roles exits 2 with `no roles configured`. Role runs record `role` in `runs.jsonl` (empty for `-a` and `-t` runs).

### Run history

Every agent run, successful or not, appends one JSON line to `~/.cache/multi-agent-router/runs.jsonl` (`$XDG_CACHE_HOME` honored): `ts`, `agent`, `tier`, `role` (TypeScript router only), `model`, `cwd`, `exit`, `seconds`, `prompt` (task without the preamble, first 2000 chars), `prompt_chars`, `answer` (first 2000 chars) and `changed_files`.

`changed_files` lists the paths of the run's git repo that changed during the run: new or different `git status` entries plus files in commits made during the run. It is empty outside a git repo. A file that was already modified before the run and is modified again does not show up. `last/<agent>.json` still keeps the latest run of each agent.

### hc backend (herdr-core)

`--backend hc` runs each agent inside a live [hc](https://herdr.dev) terminal instead of a plain subprocess. While it works, `hc attach aa-<agent>-<pid>` (printed on stderr) shows the agent live; `ctrl+\` detaches. The answer, stderr, exit code, quota detection and per-agent timeout behave exactly like the subprocess backend, and the terminal is removed when the run ends.

- Selection: `--backend hc|subprocess` flag, then `agents.<name>.backend`, then the global `backend` in `agents.json`, then `subprocess`.
- `hc_command` in `agents.json` sets the hc binary (default `hc`).
- When hc cannot start the terminal, the run falls back to the subprocess backend and logs `falling back to subprocess`.
- Terminals start with `--no-parent --no-notify`, so hc never types notes into the caller's terminal.

## Install (local)

```bash
ln -sf "$PWD/bin/ask-agent" ~/.local/bin/ask-agent
claude plugin marketplace add "$PWD"
claude plugin install multi-agent-router@multi-agent-router
```

Then `/reload-plugins` in a running session. Requires `jq`, `perl`, and the agent CLIs (`pi`, `agy`, `opencode`, `gentle-shell`).
