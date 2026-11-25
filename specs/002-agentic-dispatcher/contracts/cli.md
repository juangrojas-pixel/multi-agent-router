# CLI Contract: Agentic Dispatcher

Existing commands (`-r`, `-a`, `-t`, `-m`, `parallel`, `roles`, `status`, `runs`, `guidance`,
`config`, `reset`) keep their flags, output and exit codes.

## `ask-agent catalog [-a AGENT] [--refresh] [--json]`

Lists models per enabled agent from cache. `--refresh` re-runs each agent's `list_models` and
fetches benchmark sources first.

Text output, one block per agent:
```
agy  (listed 2026-11-25 09:10, cli)
  usable        gemini-4-neon-high       code=strong  reasoning=strong  $out/M=..  quota 99% (Gemini Models)
  out_of_quota  claude-opus-5-5-high     ...                                     quota 0% (Claude and GPT models)
  unverified    ...
sources: models-dev 2026-11-25, lmarena 2026-11-22
```
`--json`: the `catalog.json` shape merged with benchmark profiles.
Exit: 0 answered (even if some agents are unverified); 2 config error.

## `ask-agent preflight [--json]`

Reports per agent: installed vs latest version and update command, quota, model counts by
status, benchmark freshness. Changes nothing.
Exit: 0 ready; 3 outdated or stale (names each item and its update command); 1 a check failed;
2 config error.

## `ask-agent candidates --kind KIND --tier TIER [--size s|m|l] [--client] [--json] [-n N]`

`--client` keeps only agents in policy `client_agents`.

Ranked agent/model pairs that meet `TIER` for `KIND`, cheapest capable first.
```
1  agy/gemini-4-hydrogen-high   tier=standard  cost=0.4  quota 99%   cheapest capable
2  codex/openai-codex/gpt-6.1-terra  ...
!  gentle-shell/...gpt-6.2-sol  cost=7.2  over ceiling 5.0 -> use #1
```
Exit: 0 at least one candidate; 4 none meets the need (prints the best below tier); 2 bad
`KIND`/`TIER` (names the value).

## `ask-agent dispatch [-f FILE | -] [--json]`

Runs a batch (see data-model DispatchBatch). Validates all tasks before starting any:
unknown agent or role, model not usable for that agent, overlapping `writes`, a `client: true`
task naming an agent outside policy `client_agents`. Then runs up to
`dispatch.concurrency` at once; a failing task falls back by its role order (agent tasks: no
fallback unless `fallback: true` uses the agent's tier order).
Output: one `### <task_id> (<agent>/<model>)` block per task with its receipt, in task order;
`--json` prints `[Receipt]`.
Exit: 0 all tasks succeeded; 5 some failed (others still returned); 2 validation error before
start (names task and key).

## `-a AGENT -m MODEL` additions

- `--task ID` and `--reason TEXT`: recorded in `runs.jsonl`.
- A model not usable for the agent (per catalog) stops before start: exit 2,
  `model <m> is not usable for agent <a> (<status>)`. When the catalog has never been built,
  the check uses config `models` only.
