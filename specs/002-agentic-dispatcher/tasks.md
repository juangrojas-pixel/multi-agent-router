---
description: "Task list for the Agentic Dispatcher feature"
---

# Tasks: Agentic Dispatcher

**Input**: Design documents from `/specs/002-agentic-dispatcher/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli.md, quickstart.md

**Tests**: REQUIRED. Constitution VI (non-negotiable): every behavior starts with a failing test
through the public CLI, stub agents declared in config, no real agent CLI, no network. Tests
assert output, exit code and persisted state.

**Organization**: grouped by user story; each story is an independently testable increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: user story from spec.md (US1..US6)

---

## Phase 1: Setup

- [x] T001 Add benchmark fixtures `tests/fixtures/benchmarks/models-dev.json`, `lmarena.json`, `openrouter.json` trimmed from the real responses saved during research (5-8 models each, including `gemini-4-neon`, `gemini-4-hydrogen`, `gpt-6.2-sol`, `claude-sonnet-5-5`, one free opencode model)
- [x] T002 [P] Add a stub-agent helper in `tests/fixtures/stub-agent.sh` that answers `models`, `--version` and `-p` from env vars (model list, version, exit code) so tests declare stubs through config

---

## Phase 2: Foundational (blocks all stories)

- [x] T003 Write failing config-validation tests in `tests/config-validate.test.ts` for the new keys, each error exiting 2 and naming the key: "`capability_tiers` non-empty, unique; every tier used in `models.*.tier` exists in `capability_tiers`", "every key in `models.*.tier` exists in `kinds`", "`sizes` values positive integers; `cost_ceiling` > 0; `dispatch.concurrency` integer >= 1", "`parse` values belong to the built-in parser set", "`list_models.cmd[0]` and `version_cmd[0]` non-empty strings"
- [x] T004 Implement those keys and validations in `src/config.ts` (types `Agent.list_models`, `version_cmd`, `latest_cmd`, `update_cmd`, `quota_groups`, `shares_quota_with`; top-level `capability_tiers`, `kinds`, `sizes`, `cost_ceiling`, `dispatch`, `models`, `model_aliases`, `benchmarks`)
- [x] T005 Add `catalog.json` and `benchmarks.json` read/write helpers in `src/state.ts` under `stateDir()`, atomic write (temp file + rename) like the existing cooldown file

**Checkpoint**: config accepts and validates the new keys; existing tests stay green.

---

## Phase 3: US2 - Every agent runs the model it is asked for (P1)

**Goal**: requested model is passed, checked and recorded; gentle-shell has a default; Claude executor usable.
**Independent test**: stub agent run with `-m X` records `requested_model: X`; an unknown model exits 2 before start.

- [x] T006 [P] [US2] Failing tests in `tests/run-record.test.ts`: `-a stub -m X --task T1 --reason "..."` writes `task_id`, `reason`, `requested_model`, `model_source` to `runs.jsonl`; existing fields unchanged; a model outside the agent's config `models` exits 2 with `model <m> is not usable for agent <a> (<status>)` and no run entry for a started agent; regression (FR-014): `-r ROLE` with no `-m` still runs the role's agent and model
- [x] T007 [P] [US2] Failing test in `tests/role-run.test.ts`: gentle-shell with config `model` and no `-m` passes `--model <config model>` after `--`
- [x] T008 [US2] Parse `--task` and `--reason` in `src/cli.ts`; extend `record()` in `src/state.ts` with the optional fields; read the reported model from agy JSON / opencode events in `src/run.ts`, else `model_source: requested`
- [x] T009 [US2] Pre-start model check in `src/run.ts` (catalog when present, else config `models`)
- [x] T010 [US2] `agents.json`: gentle-shell `model` set to the current sol model from `pi --list-models`; claude `enabled: true`, `models: ["haiku","sonnet","opus"]`, `shares_quota_with: "orchestrator"`; keep claude out of every tier and role by default

**Checkpoint**: US2 green; `bash tests/ask-agent.test.sh` green.

---

## Phase 4: US1 - Know which models we can really use (P1)

**Goal**: `ask-agent catalog` lists usable / unavailable / out_of_quota / unverified per agent.
**Independent test**: stub reporting A, B; config declaring C -> A, B usable, C unavailable, exit 0.

- [x] T011 [P] [US1] Failing tests in `tests/catalog.test.ts`: statuses per data-model ("`unverified` -> `usable` when listed by its CLI", "`usable` -> `out_of_quota` when its quota group is under `min_remaining`", "`usable` -> `unavailable` when declared in config but absent from the CLI list"); an agent whose list command fails shows config models as `unverified` and the others still answer; `--json` shape; cache read without `--refresh` runs no agent; timing (SC-002): `--refresh` over 5 stub agents finishes under 30 s and cache read under 1 s
- [x] T012 [US1] Implement `src/catalog.ts`: run `list_models.cmd` with its timeout, parsers `tsv` and `lines-first-field`, map `quota_groups` patterns, merge config models, write `catalog.json`
- [x] T013 [US1] Wire `catalog [-a AGENT] [--refresh] [--json]` in `src/cli.ts` with the text layout from contracts/cli.md
- [x] T014 [US1] `agents.json`: `list_models` for agy (`agy models`, tsv), codex (`pi --list-models`), gentle-shell (`gentle-shell -- --list-models`), opencode (`opencode models`); `quota_groups` for agy

**Checkpoint**: MVP. Catalog answers the user's "qué modelos podemos usar".

---

## Phase 5: US3 - Preflight before starting work (P1)

**Goal**: one read-only command reports versions, quotas, models and data freshness.
**Independent test**: stub installed 1.0 / latest 1.1 -> listed outdated with update command, exit 3.

- [x] T015 [P] [US3] Failing tests in `tests/preflight.test.ts`: exit 0 all current; exit 3 outdated naming agent, installed, latest and `update_cmd`; `latest_cmd: null` gives `unknown`, never `current`; a failing check exits 1; stale benchmarks (older than `max_age_days`) exit 3; assert no file outside the cache changed and `update_cmd` never ran (stub records invocations); timing (SC-003): preflight over 5 stub agents finishes under 60 s
- [x] T016 [US3] Implement `src/preflight.ts` reusing `catalog.ts` and the agy quota reader in `src/run.ts`
- [x] T017 [US3] Wire `preflight [--json]` in `src/cli.ts`; `agents.json` `version_cmd` / `latest_cmd` / `update_cmd` per research R2

---

## Phase 6: US6 - Capability knowledge from external benchmarks (P3, before US4 because candidates read it)

**Goal**: cached per-model profiles with source and date; measured tiers by kind.
**Independent test**: refresh from `file://` fixtures -> catalog shows scores, source and date.

- [x] T018 [P] [US6] Failing tests in `tests/benchmarks.test.ts`: parsers `models-dev`, `lmarena-hf`, `openrouter` on fixtures; normalization (lower-case, strip "(High)", dots and spaces to dashes) plus `model_aliases`; unmapped model shows "no benchmark data"; unreachable source keeps previous cache and reports it stale with its date; declared tier overrides measured tier
- [x] T019 [US6] Implement `src/benchmarks.ts` (fetch via `fetch()` for http(s), file read for `file://`), tier bands from config, write `benchmarks.json`
- [x] T020 [US6] Merge profiles into `catalog` output and `--json`; `catalog --refresh` refreshes sources; add sources to `agents.json` per research R4 (models-dev, lmarena, openrouter fallback; Artificial Analysis optional with key from private policy)

---

## Phase 7: US4 - Choose agent and model per task with cost/value (P2)

**Goal**: ranked candidates, cheapest capable first, cost ceiling flag.
**Independent test**: need tier standard -> cheapest usable model at or above standard first; nothing below.

- [x] T021 [P] [US4] Failing tests in `tests/candidates.test.ts`: ranking "meets `min_tier` for `kind` -> not `out_of_quota` -> lowest `est_cost` -> highest score"; `est_cost = price_out_per_m * sizes[size] / 1e6`; free model cost 0; over `cost_ceiling` flagged with cheapest capable alternative; exit 4 when none meets the need; exit 2 naming a bad `KIND` or `TIER`; Claude candidate reason mentions shared quota; `--client` lists only policy `client_agents` (FR-018)
- [x] T022 [US4] Implement `src/candidates.ts` and wire `candidates --kind --tier [--size] [-n] [--json]` in `src/cli.ts`

---

## Phase 8: US5 - Swarm: distinct tasks to distinct agents in parallel (P2)

**Goal**: `dispatch` runs a validated batch concurrently with one receipt per task.
**Independent test**: 3 tasks to 3 stubs -> 3 receipts tied to task IDs, 3 `runs.jsonl` entries with `batch_id`.

- [x] T023 [P] [US5] Failing tests in `tests/dispatch.test.ts`: validation before any start (unknown agent/role, model not usable, overlapping `writes` by path prefix) exits 2 naming task and key; concurrency limit respected (stubs record start/end times); one failing task returns exit 5 while others still return receipts; role tasks fall back by role order; receipts printed in task order; `--json` prints `[Receipt]`; excess tasks queue, none dropped; agent task with `fallback: true` falls back by the agent's tier order, without it no fallback; `client: true` task naming an agent outside policy `client_agents` exits 2 before start, and with no `client_agents` every client task is rejected (FR-018); timing (SC-005): 3 stub tasks of 2 s each finish under 2.2 s
- [x] T024 [US5] Implement `src/dispatch.ts` with a pool over the existing `attempt()` / `runRole()` paths, `batch_id` per run
- [x] T025 [US5] Wire `dispatch [-f FILE | -] [--json]` in `src/cli.ts`; `dispatch.concurrency: 3` in `agents.json`

---

## Phase 8b: US7 - See every delegated agent in Herdr (P2)

- [x] T030 [US7] Failing tests in `tests/herdr-backend.test.ts` with a stub `herdr` (records calls, serves JSON): split `--current --direction right --cwd <cwd> --no-focus`, `pane rename`, `report-agent --state working`, `pane run`, result parity with subprocess (stdout, stderr, exit), pane closed after success and kept after failure, timeout sends ctrl+c and returns 142, fallback to subprocess when `HERDR_ENV` is unset or the split fails
- [x] T031 [US7] Implement `src/herdr.ts` (`herdrRun`) mirroring `src/hc.ts`; select it in `backendFor` in `src/run.ts`; accept `--backend herdr` in `src/cli.ts`; README section

## Phase 8c: US8 - Watch and steer each agent live (P2)

- [x] T032 [US8] Failing tests in `tests/live-backend.test.ts` with a stub hc playing an interactive agent: absolute-path start under the caller, configured dialog answered, unknown blocked dialog stops with exit 2 and keeps the terminal, task sent on idle, answer from the answer file, timeout, fallback to hc for agents without `live`
- [x] T033 [US8] Implement `src/live.ts`; select it in `backendFor`; `--backend live`; `live` config per agent (args, model_args, dialogs) validated in `src/config.ts`; agents.json for agy, codex, gentle-shell, claude; README

## Phase 9: Polish & cross-cutting

- [x] T026 Update `src/guidance.ts`: flow preflight -> catalog -> candidates -> dispatch, record `--task`/`--reason`, client-environment restriction kept; failing test first in `tests/guidance.test.ts`
- [x] T027 [P] Update help text in `src/cli.ts` and `README.md` for every new command and option (constitution: same change)
- [x] T028 [P] Update the orchestrator skill `skills/delegate/SKILL.md` so ODD task lines carry `agent/model` and reason chosen from `candidates`
- [x] T029 Run quickstart.md automated section; run manual read-only steps 1-3 against real agents and record results in the feature log

---

## Dependencies & execution order

- Setup (T001-T002) -> Foundational (T003-T005) -> stories.
- US2 and US1 are independent after Foundational. US3 needs US1 (catalog). US6 needs Foundational only. US4 needs US1 and US6. US5 needs US2 (model check) and benefits from US4.
- Within each story: tests (red) -> implementation -> config/docs.

## Parallel opportunities

- T001 and T002.
- After Phase 2: US2 (T006-T010) and US1 (T011-T014) touch different modules except `src/cli.ts`; keep `cli.ts` edits sequential.
- US6 (T018-T020) can run beside US3.
- T027 and T028 in polish.

## Implementation strategy

1. MVP = Phases 1-4 (US2 + US1): real model per run, recorded, plus the catalog.
2. Add US3 preflight, then US6 benchmarks, then US4 candidates: Claude can now justify "agy en neon porque alcanza".
3. Add US5 dispatch: the swarm.
4. Polish: guidance and skill so the orchestrator uses it on every ODD plan.
