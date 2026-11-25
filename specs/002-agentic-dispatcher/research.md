# Research: Agentic Dispatcher

All findings checked live on 2026-11-25 unless marked unverified.

## R1. Listing usable models per agent (FR-001, FR-002)

| Agent (command run) | List command | Account-aware |
|---|---|---|
| agy | `agy models` (tab-separated `id<TAB>display name`) | Fetched from the server; very likely filtered by entitlement (unverified) |
| codex (runs `pi`) | `pi --list-models [search]` | Lists only providers with credentials; models per provider come from pi's built-in list |
| gentle-shell | `gentle-shell -- --list-models` | Same as pi, inside the isolated home |
| opencode | `opencode models` | Only configured providers (all free today) |
| claude | none | Fixed aliases (`haiku`, `sonnet`, `opus`) or full names |

- **Decision**: each agent declares an optional `list_models` command in config plus a parser
  kind (`lines-first-field`, `tsv`). The catalog runs it, caches the result with a timestamp,
  and marks models from config only (no list command, or the command failed) as `unverified`.
- **Rationale**: Constitution I (only the official CLI) and II (shape lives in config, not a
  per-agent `case` in code).
- **Alternatives**: calling vendor model APIs (rejected, Constitution I); a hard-coded list
  (rejected, it goes stale; that is the user's complaint).
- **Side effect found**: the first `gentle-shell` run after its upgrade re-provisions its home
  (`gentle-ai 4.5.0 -> 5.0.0`). The catalog must accept a slow first call (timeout from config).

## R2. Installed vs latest versions (FR-005, FR-006)

| Agent | Installed | Latest, no install |
|---|---|---|
| pi (codex agent) | `pi --version` | `npm view @earendil-works/pi-coding-agent version` |
| gentle-shell | `gentle-shell --version` | `npm view gentle-pi version` |
| opencode | `opencode --version` | `npm view @opencode/cli version` |
| claude | `claude --version` | `npm view @anthropic-ai/claude-code version` |
| agy | `agy --version` | no check-only command known; `agy update` installs. Report `unknown` |

- **Decision**: per agent, config holds `version_cmd`, `latest_cmd` and `update_cmd` (the last
  one is only printed, never run). A missing `latest_cmd` yields status `unknown`, never
  `current`.
- **Rationale**: FR-006 and the offline edge case; `npm view` reads the registry and uses no
  quota.

## R3. Quota per model family

- `agy -p /usage --output-format json` returns `groups[]` ("Gemini Models", "Claude and GPT
  models") with weekly and 5-hour buckets (`src/run.ts:47-76`).
- **Decision**: each model in the catalog gets a `quota_group`, mapped by config pattern
  (for example `gemini-*` maps to "Gemini Models"). A model whose group is under
  `min_remaining` is `out_of_quota` and candidates skip it.
- Other agents report no quota through their CLI: show `n/a`, rely on cooldowns as today.

## R4. Capability and price sources (FR-012, FR-013)

| Source | Auth | Gives | Use |
|---|---|---|---|
| models.dev `api.json` | none | price per 1M, context, reasoning levels, release date; IDs match the CLIs | **primary: price and metadata** |
| LMArena HF dataset `lmarena-ai/leaderboard-dataset` | none, CC-BY-4.0 | rating per category: `coding`, `webdev`, `math`, `hard_prompts`, `creative_writing`, `instruction_following` | **primary: quality by kind of work** |
| OpenRouter `/api/v1/models` | none | price, context | fallback for price |
| Artificial Analysis v2 API | free key (signup), 100 req/day, attribution required | intelligence index, speed, price; coding index now always null | optional, speed only, key from private policy |
| Epoch AI zip | none, CC-BY | SWE-bench Verified, GPQA | later, weekly objective check |
| SWE-bench, Aider, LiveBench, Vellum | — | stale or HTML only | rejected |

- **Decision**: sources are declared in config (`benchmarks.sources[]`), each with a parser
  kind built into the core (`models-dev`, `lmarena-hf`, `openrouter`, `artificial-analysis`).
  Refresh is explicit (`catalog --refresh`) or proposed by preflight when stale. Never
  automatic in the background.
- **Name mapping**: normalize (lower-case, strip bracketed effort like "(High)", dots and
  spaces to dashes), then apply explicit config aliases. Unmapped models show "no benchmark
  data", never a fuzzy guess.
- **Attribution**: every value keeps `source` and `fetched_at`; the catalog prints sources.
- **Constitution note**: fetching public pages is network access. The constitution forbids the
  router connecting to remote servers *on its own*. Refresh and latest-version checks run only
  when the user or orchestrator invokes the command. Recorded in Complexity Tracking.

## R5. Tiers and kinds of work

- **Decision**: a small fixed vocabulary in config, not code: `tiers` ordered list
  (default `light < standard < strong < frontier`) and `kinds` (`code`, `reasoning`,
  `writing`, `review`). Each model gets a tier per kind: measured (from LMArena rank bands per
  category, thresholds in config) or declared (config). Declared always wins when present, so
  the user can override.

## R6. Cost estimate (FR-007, FR-008)

- All agents run on flat subscriptions. "Cost" = relative price indicator (models.dev USD per
  1M output tokens x expected size) plus the quota pressure of its group.
- **Decision**: task size is `s|m|l` mapped to token budgets in config. Estimated cost =
  `price_out x budget`, shown as relative units, plus `quota_left`. Ranking: meets tier, then
  quota not exhausted, then lowest cost, then highest measured score. A free agent (opencode)
  costs 0. The Claude executor carries a `shares_quota_with: orchestrator` flag that shows in
  the reason.
- `cost_ceiling` in config: a candidate above it is flagged and the cheapest capable
  alternative is named.

## R7. Batch dispatch / swarm (FR-009..FR-011)

- Today `parallel` sends one prompt to many agents (`src/run.ts:243-262`); roles run in
  sequence (`src/roles.ts:29-36`).
- **Decision**: new `dispatch` command reading a batch file (JSON, from stdin or `-f`): tasks
  with `id`, `agent` or `role`, `model`, `cwd`, `writes[]`, `prompt`. It validates everything
  first (agent, model usable, overlapping `writes`), then runs up to `dispatch.concurrency`
  (default 3) at once reusing `attempt()` and the fallback path, and prints one receipt block
  per task plus a JSON summary with `--json`.
- `parallel` stays unchanged (Constitution V).

## R8. Recording the choice (FR-004)

- `runs.jsonl` today: `ts, agent, tier, role, model, cwd, exit, seconds, prompt, ...`
  (`src/state.ts:125-138`).
- **Decision**: add optional `task_id`, `reason`, `requested_model`, `batch_id`. Existing fields
  keep their names, so `route-hint` and the status line keep working.
- "Model actually used": the router only knows what it passed. For agy JSON and opencode events
  the model is in the output; parse it when present, else record the requested one and mark
  `model_source: requested`.
