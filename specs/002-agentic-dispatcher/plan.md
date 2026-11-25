# Implementation Plan: Agentic Dispatcher

**Branch**: `feat/router` (spec directory `002-agentic-dispatcher`) | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-agentic-dispatcher/spec.md`

## Summary

Make the router the control point for every agent. Four new commands give the orchestrator
evidence and a way to act on it: `catalog` (usable models per agent, with tier, price and
quota, plus cached benchmark profiles), `preflight` (versions, quotas, models and data
freshness; reports only), `candidates` (ranked agent/model pairs for a task need, cheapest
capable first, with cost ceiling) and `dispatch` (a batch of distinct tasks run concurrently,
one receipt each). Every run records requested model, task ID and reason. Roles stay the
default route. The Claude executor is enabled as an option and gentle-shell gets a default
model in config.

Technical approach: extend the existing TypeScript router (Node 24, no build step, no runtime
dependencies). Agent model listing and version checks are config-declared commands. Benchmark
sources are config-declared with parser kinds built into the core. Network access happens only
when a command is invoked explicitly. See [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript executed directly by Node 24 (erasable syntax only)

**Primary Dependencies**: none at runtime; Node built-ins only (`fetch`, `child_process`,
`node:test`)

**Storage**: JSON files. Config: `agents.json` plus private `policy.json`. State under the
existing cache directory: `runs.jsonl`, `cooldown.json`, new `catalog.json` (models per agent,
`fetched_at`), new `benchmarks.json` (profiles per model with source and date)

**Testing**: `node:test` through the public CLI with stub agents declared in config; benchmark
sources replaced by local fixture files (`file://` URLs) declared in test config. Parity suite
`tests/ask-agent.test.sh` must stay green

**Target Platform**: Linux, single user, one machine

**Project Type**: CLI

**Performance Goals**: `catalog` from cache under 1 s; `catalog --refresh` under 30 s for all
agents (SC-002); `preflight` under 60 s (SC-003); dispatch overhead under 10% of the slowest
task (SC-005)

**Constraints**: existing commands keep flags, output and exit codes; `runs.jsonl` only gains
optional fields; no real agent CLI or network in tests; preflight never mutates

**Scale/Scope**: about 5 agents, about 60 models, 2 to 4 benchmark sources. Roughly 1,000 lines
of TypeScript plus tests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the design complies |
|---|---|---|
| I. Official CLIs only | PASS | Models and versions come from each vendor CLI (`agy models`, `pi --list-models`, `--version`); benchmark data comes from public pages, not vendor APIs |
| II. Config is the source of truth | PASS | List/version commands, tiers, kinds, size budgets, cost ceiling, concurrency, sources and name aliases live in config. Roles remain the default route; the orchestrator's explicit `-a/-m` choice per task was already a supported call shape |
| III. Host-agnostic core | PASS | All decision data comes from the CLI; `guidance` explains it in product-neutral text |
| IV. Private policy out of the repo | PASS | Optional Artificial Analysis key and client-routing restrictions live in `policy.json` |
| V. Parity before replacement | PASS | `parallel`, `-r`, `-a`, `-t` unchanged; `dispatch` is new; `runs.jsonl` only gains fields |
| VI. Test-first through the CLI | PASS | Every story starts with failing CLI tests on stub agents and fixture sources |
| VII. Fail loudly, fall back by config | PASS | Unusable model or overlapping writes stop the batch before any agent starts; batch tasks fall back by their role order; every attempt recorded |

Scope note: the constitution says the router never "connects to remote servers on its own".
Refresh and latest-version checks fetch public data only when explicitly invoked; see
Complexity Tracking.

Post-design re-check: PASS (see Complexity Tracking for the single recorded exception).

## Project Structure

### Documentation (this feature)

```text
specs/002-agentic-dispatcher/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── cli.md
└── tasks.md             # /speckit-tasks output
```

### Source Code (repository root)

```text
src/
├── cli.ts          # new command dispatch: catalog, preflight, candidates, dispatch
├── config.ts       # new keys: list_models, version_cmd, latest_cmd, update_cmd, tiers,
│                   #   kinds, sizes, cost_ceiling, dispatch, benchmarks, model_aliases
├── catalog.ts      # NEW: model discovery per agent, cache, status per model
├── benchmarks.ts   # NEW: source fetch, parsers (models-dev, lmarena-hf, openrouter,
│                   #   artificial-analysis), name normalization, profile cache
├── preflight.ts    # NEW: versions, quotas, models, freshness; exit status
├── candidates.ts   # NEW: tier filter, cost estimate, ranking, ceiling flag
├── dispatch.ts     # NEW: batch validation, concurrency pool, receipts
├── run.ts          # record task_id, reason, requested_model, batch_id
├── state.ts        # catalog.json / benchmarks.json read-write; runs.jsonl fields
└── guidance.ts     # orchestrator guidance for the new flow

tests/
├── catalog.test.ts
├── benchmarks.test.ts
├── preflight.test.ts
├── candidates.test.ts
├── dispatch.test.ts
├── run-record.test.ts
└── fixtures/benchmarks/   # models-dev.json, lmarena.json, openrouter.json
```

**Structure Decision**: single CLI project; one new module per command, sharing config,
state and the existing `attempt()` run path.

## Delivery order

1. Run record fields + gentle-shell default model + Claude executor enable (US2).
2. `catalog` with config-declared list commands and quota groups (US1).
3. `preflight` (US3).
4. Benchmarks refresh and profiles (US6), feeding measured tiers into the catalog.
5. `candidates` (US4).
6. `dispatch` (US5).
7. `guidance`, README, help text; orchestrator skill updated to plan ODD tasks with
   `agent/model` per task.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Network reads of public benchmark pages and the npm registry (constitution: router never connects to remote servers on its own) | The user asked for always-current model capability and version checks | Hand-maintained tiers go stale, which is the problem the user reported. Mitigation: reads only on explicit `catalog --refresh` / `preflight`, read-only HTTP GET, no credentials except the optional AA key from private policy |
