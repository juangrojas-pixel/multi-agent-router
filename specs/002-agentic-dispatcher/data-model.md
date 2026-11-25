# Data Model: Agentic Dispatcher

## Config additions (`agents.json`, validated before any agent starts)

```jsonc
{
  "agents": {
    "agy": {
      "list_models": { "cmd": ["agy", "models"], "parse": "tsv", "timeout_seconds": 60 },
      "version_cmd": ["agy", "--version"],
      "latest_cmd": null,                    // null -> version status "unknown"
      "update_cmd": "agy update",            // printed only, never run
      "quota_groups": { "gemini-*": "Gemini Models", "*": "Claude and GPT models" }
    },
    "gentle-shell": { "model": "openai-codex/gpt-6.2-sol" },
    "claude": { "enabled": true, "models": ["haiku", "sonnet", "opus"],
                "shares_quota_with": "orchestrator" }
  },
  "tiers": ["light", "standard", "strong", "frontier"],
  "kinds": ["code", "reasoning", "writing", "review"],
  "sizes": { "s": 20000, "m": 80000, "l": 250000 },        // expected output tokens
  "cost_ceiling": 5.0,                                       // relative units
  "dispatch": { "concurrency": 3 },
  "models": {                                                // declared facts, override measured
    "gemini-4-neon-high": { "tier": { "code": "strong", "reasoning": "strong" } }
  },
  "model_aliases": { "gemini-4-neon-high": "gemini-4-neon" },
  "benchmarks": {
    "max_age_days": 7,
    "sources": [
      { "id": "models-dev", "url": "https://models.dev/api.json", "parse": "models-dev" },
      { "id": "lmarena", "url": "https://datasets-server.huggingface.co/...", "parse": "lmarena-hf",
        "categories": { "code": ["coding", "webdev"], "reasoning": ["math", "hard_prompts"],
                        "writing": ["creative_writing", "instruction_following"] },
        "tier_bands": { "frontier": 5, "strong": 15, "standard": 40 } },
      { "id": "openrouter", "url": "https://openrouter.ai/api/v1/models", "parse": "openrouter",
        "role": "fallback" }
    ]
  }
}
```

Validation rules (Constitution VII, exit 2 naming the key):
- `tiers` non-empty, unique; every tier used in `models.*.tier` exists in `tiers`.
- every key in `models.*.tier` exists in `kinds`.
- `sizes` values positive integers; `cost_ceiling` > 0; `dispatch.concurrency` integer >= 1.
- `parse` values belong to the built-in parser set.
- `list_models.cmd[0]` and `version_cmd[0]` non-empty strings.

## State files (cache directory)

### `catalog.json`
| Field | Type | Notes |
|---|---|---|
| `fetched_at` | ISO time | per agent |
| `agents.<id>.models[]` | list | `{ id, status, reason?, quota_group?, quota_left?, source }` |
| `status` | enum | `usable` \| `unavailable` \| `out_of_quota` \| `unverified` |
| `source` | enum | `cli` (listed by the agent) \| `config` (declared only) |

State transitions per model: `unverified` -> `usable` when listed by its CLI;
`usable` -> `out_of_quota` when its quota group is under `min_remaining`, back to `usable` at
reset; `usable` -> `unavailable` when declared in config but absent from the CLI list.

### `benchmarks.json`
| Field | Type | Notes |
|---|---|---|
| `sources.<id>.fetched_at` | ISO time | stale when older than `max_age_days` |
| `models.<normalized id>.price_out_per_m` | number | from models-dev, else openrouter |
| `models.<normalized id>.scores.<kind>` | `{ rank, rating, source, date }` | from lmarena |
| `models.<normalized id>.tier.<kind>` | tier | measured from rank bands |

### `runs.jsonl` (added optional fields)
`task_id`, `batch_id`, `reason`, `requested_model`, `model_source` (`reported` | `requested`).
Existing fields unchanged.

## Runtime entities

- **TaskNeed**: `{ kind, min_tier, size }`.
- **Candidate**: `{ agent, model, tier, est_cost, quota_left, over_ceiling, reason }`.
  Ranking: meets `min_tier` for `kind` -> not `out_of_quota` -> lowest `est_cost` -> highest
  score. `est_cost = price_out_per_m * sizes[size] / 1e6`; free models cost 0.
- **DispatchBatch**: `{ batch_id, tasks: [{ id, agent|role, model?, cwd, writes[], prompt,
  client?, fallback? }] }`.
  Rules: no two tasks' `writes` overlap (path prefix); each `model` usable for its agent; a task
  with `client: true` may only name agents in private policy `client_agents` (FR-018).
- **Private policy addition** (`policy.json`): `client_agents: ["claude", "gentle-shell"]`.
  Absent -> no agent is allowed for `client: true` tasks (fail closed).
- **Receipt**: `{ task_id, agent, model, exit, seconds, changed_files, answer }`.
- **PreflightReport**: per agent `{ version: {installed, latest, status, update_cmd},
  quota, models: {usable, unavailable, out_of_quota}, }` plus `benchmarks: {fresh|stale|missing}`.
  Exit: 0 ready, 3 outdated or stale, 1 failed check.
