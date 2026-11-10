# Data Model: Role-Based Agent Routing

All entities live in the config file (`agents.json`, optionally merged with the private
policy file) or in the state directory. There is no database.

## Config (merged)

| Key | Type | Notes |
|---|---|---|
| `cooldown_seconds` | number | existing |
| `default_tier` | string | existing |
| `tiers` | map of tier name to agent ids | existing, unchanged |
| `agents` | map of agent id to Agent | existing, extended |
| `roles` | map of role name to Role | **new** |
| `orchestrator` | Orchestrator | **new**, optional |
| `routing` | object | existing; gains `notes` (free text) and `rules[].role` |
| `backend`, `hc_command` | string | existing |

## Agent

Existing keys are unchanged: `enabled`, `description`, `command`, `model`, `timeout_seconds`,
`extra_args`, `prompt_preamble`, `fallback`, `quota`, `backend`.

New, all optional:

| Key | Type | Meaning |
|---|---|---|
| `args` | string[] | argument template; placeholders `{prompt}`, `{timeout}`, and the insertion points `{model_args}`, `{effort_args}`, `{extra_args}` |
| `model_args` | string[] | fragment added when a model is set, for example `["--model", "{model}"]` |
| `effort_args` | string[] | fragment added when an effort is set, for example `["--thinking", "{effort}"]` |
| `output` | `text` \| `agy-json` \| `opencode-events` | how the answer is read from stdout |
| `models` | string[] | models a role may set; absent means any |
| `effort_levels` | string[] | effort levels a role may set; absent or empty means none |

Agents with id `codex`, `agy`, `opencode` or `gentle-shell` that omit `args` and `output` get
built-in defaults equal to today's behavior.

## Role

| Key | Type | Meaning |
|---|---|---|
| `description` | string | what the role is for; shown in the listing and in the guidance |
| `agents` | RoleAgent[] (at least one) | tried in this order |
| `model` | string, optional | default model for entries that set none |
| `effort` | string, optional | default effort for entries that set none |

**RoleAgent** is either an agent id string or an object `{ "agent", "model"?, "effort"? }`.
The entry's own value wins over the role default, which wins over the agent's `model`.

## Orchestrator

`{ "agent": "<agent id>" }`. The agent that holds the orchestrating role. Informational for
the guidance and the listing; adapters decide nothing from it.

## Validation rules (all checked before any agent starts)

| Rule | Message names |
|---|---|
| role has no agents | `roles.<name>.agents` |
| role entry names an agent missing from `agents` | `roles.<name>.agents[i]` and the agent id |
| model set, agent declares `models`, model not in it | `roles.<name>` entry and the model |
| effort set, agent has no `effort_levels` | `roles.<name>` entry and the agent id |
| effort set, level not in `effort_levels` | `roles.<name>` entry and the level |
| `orchestrator.agent` missing from `agents` | `orchestrator.agent` |
| `routing.rules[i].role` missing from `roles` | `routing.rules[i].role` |
| `output` not a known parser | `agents.<id>.output` |
| private policy file is not valid JSON or fails a rule above | the file path and the key |

A duplicate agent inside one role is not an error; it is tried once.

## Resolution of a role-based run

1. Validate the merged config.
2. Take the role's entries in order, dropping duplicates.
3. Skip entries whose agent is disabled, whose command is not installed, or that are in
   cooldown; record the reason.
4. Start the first remaining entry with its resolved model and effort.
5. On quota error (cooldown is set), timeout, failure or empty answer, go to the next entry.
6. No entry left: stop with a message naming the role and each skip reason.

Per-agent `fallback` lists are not consulted for role runs; the role's own order is the
fallback order.

## State (unchanged location: `${XDG_CACHE_HOME:-~/.cache}/multi-agent-router/`)

- `cooldown.json`: `{ "<agent id>": <until epoch> }`. Shared with the bash router and
  `route-hint`.
- `runs.jsonl`: one line per attempt. Existing fields plus optional `role`.
- `last/<agent>.json`: latest run per agent, unchanged.
