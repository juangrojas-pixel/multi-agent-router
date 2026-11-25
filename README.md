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
- `bin/route-hint`: `UserPromptSubmit` hook. Reads the merged config once per prompt (`bin/ask-agent-ts config`, by path; `agents.json` itself when that call fails or prints nothing), so rules, directive, role cooldowns and the `routing.general` fall back include the private policy file. Matches the prompt against `routing.rules` and injects a concrete `ROUTE NOW ... ask-agent -a <agent>` directive, nothing for inline rules, or the router guidance (`bin/ask-agent-ts guidance`, falling back to `routing.general`) when no rule matches. When the matched agent is in cooldown (out of quota, from `ask-agent`'s `cooldown.json`), it injects a `SKIP DELEGATION` note instead, until the cooldown expires. Logs each decision to `~/.cache/multi-agent-router/route.jsonl` (rule, agent, prompt length; never the prompt text). `route-hint --stats` counts decisions per rule. Generic rule order in `agents.json` (first match wins): `inline-explicit`, `explicit-delegate` (user asks for agents), `inline-sensitive` (secrets, restarts, opening ports), then `second-opinion`, `design`, `docs`, `spec`. Site rules go in the private policy file, whose `routing.rules` array replaces this list. Tests: `tests/route-hint.test.sh`, `tests/ask-agent.test.sh`.
- `agents/`: subagents `codex-thinker`, `agy-worker`, `opencode-docs`.
- `skills/delegate`: tier policy and how to delegate.
- `hooks/register.ts`: checks readiness at session start (status line) and injects a short frame, the router guidance (`bin/ask-agent-ts guidance`, falling back to `routing.general`) and readiness into the system prompt.

## Usage

```bash
ask-agent status
ask-agent -t think "question"            # first ready agent in the tier
ask-agent -a opencode "draft a README"   # force one agent
ask-agent parallel -t think "question"   # every ready agent, one section each
ask-agent reset [agent]                  # clear cooldowns
ask-agent --backend hc -a codex "question"   # run the agent in a live hc terminal
ask-agent runs [N] [-a agent]            # run history, last N (default 20)
ask-agent -r coder "task"                # run as a role
ask-agent roles                          # what each role resolves to, and readiness
ask-agent config                         # merged config (agents.json + private policy) as JSON
```

`ask-agent` on PATH (`~/.local/bin/ask-agent`) points at `bin/ask-agent-ts`, the TypeScript router, which runs every command above itself with the same output as the bash router `bin/ask-agent`. The bash router stays in the repository as the fallback: to go back, point the link at `bin/ask-agent` (`ln -sfn "$PWD/bin/ask-agent" ~/.local/bin/ask-agent`). The differences: it prints cooldown times (`cooldown until HH:MM`, `cooled down until YYYY-MM-DD HH:MM`) where the bash router's `date -r` prints nothing under GNU date, and `runs 0` exits 0.

### Roles

`roles` in `agents.json` names who does what. Each role has a `description`, an ordered `agents` list and optional `model` and `effort` defaults. An entry is an agent id or `{ "agent", "model", "effort" }`; the entry's own value wins over the role default, which wins over the agent's `model`. The effort reaches the agent through its `effort_args` (for example `["--thinking", "{effort}"]`), and a role may set it only on an agent that declares `effort_levels`. A role may also set `prompt_preamble`: task instructions sent after the agent's own `prompt_preamble` (which keeps its safety rules) and before the prompt.

```json
"roles": {
  "coder": { "description": "Writes and edits code from a clear task.", "agents": ["gentle-shell", "agy"] },
  "docs": { "description": "Drafts low-stakes text.", "agents": ["opencode", { "agent": "agy", "model": "gemini-3-flash" }] }
}
```

`-r ROLE` (or `--role ROLE`) runs the task on the role's agents in order. An entry that is disabled, not installed or in cooldown is skipped; one that hits a quota error (which also sets its cooldown), times out, fails or answers nothing hands the task to the next. Each step prints `[ask-agent] role NAME: AGENT failed (REASON), trying NEXT` on stderr; when no entry can answer, the last line is `[ask-agent] role NAME: no agent could run` and the exit status is 2. Per-agent `fallback` lists apply to `-a` only, never to roles. It cannot be combined with `-a`, `-t` or `-m` (exit 2). An unknown role exits 2 with `unknown role: NAME (configured: ...)`; a config without roles exits 2 with `no roles configured`. Role runs record `role` in `runs.jsonl` (empty for `-a` and `-t` runs).

`roles` prints one tab-separated line per role entry: `role agent model effort ready reason`, with `-` for an unset model or effort, `ready` `yes` or `no`, and `reason` `disabled`, `not installed` or `cooldown until HH:MM`. It never starts an agent (agy's quota is not queried). When `orchestrator` is set, the first line is `orchestrator AGENT`. Exit 0 even when entries are not ready.

#### Agent keys

Besides `enabled`, `command`, `model`, `timeout_seconds`, `extra_args`, `fallback` and `quota`, an agent may declare:

- `args`: argument template with `{prompt}`, `{timeout}` and the insertion points `{model_args}`, `{effort_args}`, `{extra_args}`. Built-in templates exist for `codex`, `agy`, `opencode` and `gentle-shell`; any other agent needs `args`.
- `model_args`: fragment added when a model is set, for example `["--model", "{model}"]`.
- `effort_args`: fragment added when an effort is set, for example `["--thinking", "{effort}"]`.
- `output`: how the answer is read from stdout: `text`, `agy-json`, `opencode-events` or `claude-json` (Claude Code `-p --output-format json`: answer from `result`, model from `modelUsage`).
- `models`: models a role may set; absent means any.
- `effort_levels`: effort levels a role may set; absent or empty means none.

#### Config checks

The TypeScript router checks the whole config before any command and stops with exit 2 and `[ask-agent] config: KEY: MESSAGE` on: a role with no agents (`roles.NAME.agents`), an entry naming an unknown agent, a model outside the agent's `models`, an effort on an agent without `effort_levels` or outside them (`roles.NAME.agents[i]`), an unknown `orchestrator.agent`, an unknown `routing.rules[i].role`, and an unknown `agents.ID.output`. A repeated agent inside a role is not an error; it is tried once.

### Orchestrator and adapters

`orchestrator` in `agents.json` (`{ "agent": "claude" }`) says which agent orchestrates. It is informational: `roles` lists it first and nothing routes by it. The orchestrator agent must exist in `agents`; the example `claude` entry is disabled so no tier or role picks it as a delegate.

`ask-agent guidance` prints the routing guidance for whichever agent orchestrates: one line per role with its description and the call to make, then `routing.notes`. It names no orchestrating product. The call form is `ask-agent -r ROLE`.

Two adapters deliver that same text and hold no rule, role or agent name of their own. Both call `bin/ask-agent-ts` by path and fall back to `routing.general` when it fails or prints nothing, read from `bin/ask-agent-ts config` first and from `agents.json` only when that call fails:

- Claude Code: `hooks/register.ts` adds it to the system prompt with the agent readiness line, and `bin/route-hint` injects it for prompts that match no rule.
- gentle-shell: `adapters/gentle-shell/orchestrate [ARGS]` starts `gentle-shell -- --append-system-prompt "<guidance>" ARGS`.

A `routing.rules` entry names an `agent` (directive `ask-agent -a AGENT`) or a `role` (directive `ask-agent -r ROLE`); the directive template takes `{call}` for that command, plus `{rule}`, `{agent}` (the agent or role name) and `{verify}`. A role rule skips delegation only when every agent of the role is in cooldown.

### Private policy file

Site-specific text (client guards, confirmation protocols, client preambles) can live outside the repository in `${XDG_CONFIG_HOME:-~/.config}/multi-agent-router/policy.json`, or the path in `ASK_AGENT_POLICY`. It has the same shape as `agents.json` and is merged over it by the TypeScript router: objects merge key by key, scalars and arrays from the private file replace. A missing file is not an error. Invalid JSON, a file that is not a JSON object, or a mistake that appears only after the merge exits 2 naming the file: `[ask-agent] config: PATH: KEY: MESSAGE`. `tests/fixtures/policy.example.json` is a neutral example.

`ask-agent config` prints the merged config (`agents.json` with the private file over it) as JSON, after the same checks as every command; it also works inside a nested call. `bin/route-hint`, `hooks/register.ts` and `adapters/gentle-shell/orchestrate` read the policy through it, so they see the private file too.

`agents.json` holds only generic preambles, routing text and rules. The bash fallback router (`bin/ask-agent`) does not read the private file, so from now on it runs with those generic preambles and routing text; site preambles and rules reach agents only through the TypeScript router (`bin/ask-agent-ts`, which `ask-agent` on PATH points to).

### Run history

Every agent run, successful or not, appends one JSON line to `~/.cache/multi-agent-router/runs.jsonl` (`$XDG_CACHE_HOME` honored): `ts`, `agent`, `tier`, `role` (TypeScript router only), `model`, `cwd`, `exit`, `seconds`, `prompt` (task without the preamble, first 2000 chars), `prompt_chars`, `answer` (first 2000 chars) and `changed_files`. The TypeScript router also records `requested_model` (the `-m` or role model, empty when none), `model_source` (`reported` when the agent's output names the model it ran, which only `claude-json` does; otherwise `requested`, and `model` is the one the router passed), `tokens_in` and `tokens_out` when the output reports usage (`agy-json`, `opencode-events`, `claude-json`; output tokens include thinking/reasoning), and, when given, `task_id` (`--task ID`) and `reason` (`--reason TEXT`), so each delegated task keeps who ran it, with which model and why.

### Model catalog

`ask-agent catalog [-a AGENT] [--refresh] [--json]` lists, per enabled agent, the models it can run right now. `--refresh` runs each agent's `list_models` command (its own CLI, no quota spent) and writes `~/.cache/multi-agent-router/catalog.json`; without it the cache is read and no agent runs (a missing cache refreshes). Each model is `usable` (listed by the agent), `unavailable` (in config `models` but not listed), `out_of_quota` (its agy quota group is under `quota.min_remaining`) or `unverified` (the agent has no list command, or it failed: config `models` are shown). `-a AGENT` refreshes or shows one agent and keeps the others in the cache.

```json
"agy": {
  "list_models": { "cmd": ["agy", "models"], "parse": "tsv", "timeout_seconds": 60 },
  "quota_groups": { "gemini-*": "Gemini Models", "*": "Claude and GPT models" }
}
```

Parsers: `tsv` (first tab field), `lines-first-field` (first word of lines that look like a model id) and `pi-table` (`pi --list-models` rows, joined as `provider/model`, the form `--model` takes). `quota_groups` maps model ids to agy usage groups by glob, first match wins.

### Benchmark profiles

With `benchmarks` configured, only `ask-agent catalog --refresh` fetches benchmark sources. Plain `catalog` reads the cache, and `preflight` only checks its age. If a source is unreachable, the last successful data and date stay visible as `stale`; a source with no cached data is `failed`. The `sources:` line shows each source's date and status (`-` means no successful fetch).

- [models.dev](https://models.dev/) supplies primary output prices in USD per million tokens and model metadata. [OpenRouter](https://openrouter.ai/) supplies fallback prices for models absent from models.dev.
- [Epoch AI](https://epoch.ai/) supplies FrontierSWE agentic-coding scores. The `epoch-zip` parser uses `files` to map kinds to ZIP CSV filenames and model/score columns, and `score_bands` to set tier thresholds from 0 to 1.
- [LMArena's leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)) supplies ratings and ranks. The best rank among each kind's mapped categories determines its measured tier.
- [Artificial Analysis](https://artificialanalysis.ai/) is an optional speed source. It requires attribution and an API key in `benchmarks.sources[].api_key` in private policy, never in the repository. Private policy replaces the `sources` array, so include the public sources you want to retain. Without a key, that source is skipped without a request.

For each model and kind, the first source in `benchmarks.sources` that measures a tier wins. By default Epoch decides `code` where it has a score; LMArena covers other kinds and models missing from Epoch.

Set `model_aliases` for names that don't match after normalization. A tier declared in `models.<id>.tier` overrides a measured one and is marked `*`. `$out/M` is a price indicator, not a subscription charge. `catalog --json` adds `profile` to each model; `null` means no benchmark data or declared tier, and the text view adds nothing for that model.

### Candidates

`ask-agent candidates --kind KIND --tier TIER [--size s|m|l] [--client] [-n N] [--json]` ranks `(agent, model)` pairs from the cached catalog and benchmark profiles that meet or exceed `TIER` (in `capability_tiers` order) for `KIND` (from `kinds`). Only `usable` and `unverified` models are eligible (`out_of_quota`, `unavailable`, and untiered models are skipped).

Candidates are ordered by lowest `est_cost` (`price_out_per_m * sizes[size] / 1e6`, rounded to 2 decimals; default size `m`; free models cost `0`; models without price sort after priced ones and show `cost=?`), then highest LMArena score for `KIND` (lowest rank), then agent order in `agents.json`. A candidate above `cost_ceiling` is marked `!` in place of its rank with `over ceiling C -> use #N` pointing to the cheapest capable alternative under the ceiling. Agents with `shares_quota_with` note `shares <x> quota` in their reason, declared tiers carry `*`, and quota is shown only when known.

`--client` restricts candidates to agents listed in `client_agents` from the private policy file (fail-closed when absent). `-n N` limits results (default `5`); `--json` prints the array of `{ agent, model, tier, tier_source, est_cost, quota_left, over_ceiling, reason }` objects. Exit codes: `0` at least one candidate, `4` none meets the need (prints the best model below `TIER` on stderr when any model has a tier for `KIND`) or no agent allowed for `--client`, `2` invalid usage or unknown `KIND`, `TIER`, or `size`.

### Dispatch (swarm)

`ask-agent dispatch [-f FILE | -] [--json]` runs a batch of distinct tasks concurrently, each in its own child router process, up to `dispatch.concurrency` at once (default `3`; excess tasks queue in order, none dropped). Before any task starts, the whole batch is validated: JSON syntax and required fields (`id`, `cwd`, `prompt`, and exactly one of `agent` or `role`), unknown agent or role, model usability via `catalog.json` or config `models`, duplicate task IDs, overlapping `writes` paths (resolved against each task's `cwd` by path prefix), and `client: true` tasks against `client_agents` in private policy (fail-closed when absent; role tasks check every agent of the role). Any validation error exits `2` naming the task and key without starting an agent.

```json
{
  "batch_id": "b-feature-docs",
  "tasks": [
    {
      "id": "impl",
      "agent": "agy",
      "model": "gemini-4-neon-high",
      "cwd": "/path/to/repo",
      "writes": ["src/dispatch.ts"],
      "prompt": "Implement batch dispatch.",
      "reason": "strong code tier"
    },
    {
      "id": "docs",
      "role": "docs",
      "cwd": "/path/to/repo",
      "writes": ["README.md"],
      "prompt": "Document the dispatch command."
    }
  ]
}
```

Role tasks fall back along their role order; agent tasks run only the named agent unless `fallback: true`, which uses the agent's config `fallback` list. Every attempt is recorded in `runs.jsonl` with `task_id`, `reason` (when given), and a shared `batch_id` (generated as `b-<epoch>-<pid>` when omitted). Output prints one `### <task_id> (<agent or role>/<model or default>)` block per task in task order (or `_(no answer: ...)_` on failure), followed by each child's stderr in task order; `--json` prints `[{ task_id, agent, role, model, exit, seconds, answer }]`. Exit codes: `0` all tasks succeeded, `5` some failed (other receipts still returned), `2` validation or usage error before start.

### Preflight

`ask-agent preflight [--json]` checks the installed and latest CLI versions for enabled agents, refreshes the model catalog, and reports model counts by status, the lowest known quota per agent, and benchmark cache freshness. Missing or failed version lookups show `unknown`; benchmark freshness is checked locally, with no benchmark download. Without benchmark configuration, it shows `not configured`.

Preflight reports configured update commands for outdated agents but never runs them. Exit codes: `0` ready, `3` outdated agent or missing/stale benchmark data, `1` failed check, `2` invalid configuration or usage.

### Choosing the model per task

`-a AGENT -m MODEL` checks the model before the agent starts. When `catalog.json` (written by `ask-agent catalog`) lists the agent, only models it marks `usable` or `unverified` run; otherwise the agent's config `models` decide, and an agent without `models` accepts any model. A refused model exits 2 with `model MODEL is not usable for agent AGENT (REASON)` and records no run. A model missing from a catalog the agent's own CLI wrote triggers one refresh of that agent first (`catalog refreshed for AGENT: MODEL is usable`), so a model released after the last refresh is not refused. Fallback agents (`fallback` in config) that cannot run the requested model are skipped with `skip AGENT: model MODEL is not usable (REASON)` instead of being run with it.

The `claude` agent (Claude Code in print mode) is enabled for explicit use only: `-a claude -m haiku|sonnet|opus`. It is in no tier or role, so nothing routes to it by default, but `status` and the status line now list it as ready. It shares the orchestrator's quota (`shares_quota_with`).

`changed_files` lists the paths of the run's git repo that changed during the run: new or different `git status` entries plus files in commits made during the run. It is empty outside a git repo. A file that was already modified before the run and is modified again does not show up. `last/<agent>.json` still keeps the latest run of each agent.

### herdr backend (see agents in Herdr)

`--backend herdr` (or `backend: "herdr"` in `agents.json`, globally or per agent) runs each agent in a sibling pane of the Herdr pane the orchestrator runs in, so you watch it work and it shows in Herdr's sidebar. Per run the router:

- splits the calling pane to the right without taking focus (`herdr pane split --current --direction right --cwd <cwd> --no-focus`);
- labels the pane `<agent> <task or model>` and reports the agent `working` (`herdr pane report-agent --source ask-agent`);
- runs the agent there with its arguments read from a file (the prompt never goes through the pane's command line) and returns the same stdout, stderr, exit code, quota detection and timeout as a subprocess run;
- on success releases the agent and closes the pane; on failure reports it `idle` with `failed (exit N)` and leaves the pane open to read; on timeout sends `ctrl+c` and returns the timeout result.

It needs the orchestrator itself inside a Herdr pane (`HERDR_ENV=1`): from another machine, attach to a Herdr session on this host (`herdr --remote <ssh-alias>`) rather than a plain SSH pane. Outside Herdr, or when the split is refused, the run falls back to a subprocess and logs `herdr unavailable (...), falling back to subprocess`. `herdr_command` sets the binary (default `herdr`).

### hc backend (herdr-core)

`--backend hc` runs each agent inside a live [hc](https://herdr.dev) terminal instead of a plain subprocess. While it works, `hc attach aa-<agent>-<pid>` (printed on stderr) shows the agent live; `ctrl+\` detaches. The answer, stderr, exit code, quota detection and per-agent timeout behave exactly like the subprocess backend, and the terminal is removed when the run ends.

- Selection: `--backend hc|subprocess` flag, then `agents.<name>.backend`, then the global `backend` in `agents.json`, then `subprocess`. It applies to `-a`, `-t`, `-r` and `parallel` runs alike.
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
