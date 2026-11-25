# agentic-dispatcher

Objective: make the router the control point for every agent: usable-model catalog, real model per run, preflight, cost/value candidates, benchmark profiles and swarm dispatch, so the orchestrator picks agent and model per ODD task.
Branch: `feat/router`. Delivery strategy: `ask-on-risk`. Forecast: about 1,000 authored lines plus tests (over 400), one commit per phase. This session: MVP = Phases 1-4 (US2 + US1).
Test runner: `node --test --test-reporter=tap tests/*.test.ts`, `bash tests/ask-agent.test.sh`, `bash tests/route-hint.test.sh`.

## Specs

Authority: `specs/002-agentic-dispatcher/` (spec.md, plan.md, research.md, data-model.md, contracts/cli.md, quickstart.md, tasks.md) under `.specify/memory/constitution.md`.

- S1. "quiero que si sea la aplicacion que controle todos mis agentes": router as control point. spec.md Context, FR-014, FR-016.
- S2. "que haya una ofrma de consultar siempre los modelos que tenemos disponibles y podemos utilizar , por que a veces hay modelos que salen pero no podemos utilizar": catalog. US1, FR-001, FR-002.
- S3. "que cada quien pueda elegir su modelo": real model per run, recorded. US2, FR-003, FR-004.
- S4. "antes de iniciar algo verificar quue todo este actualizaod": preflight, report only. US3, FR-005, FR-006.
- S5. "que valida costo valor si hago una tarea que me va a gastar mucho mejor la hago con otro": candidates. US4, FR-007, FR-008.
- S6. "que claude pueda decidir si es mejor mandar varios agentes, hacer un ajambre de agentes": dispatch. US5, FR-009 to FR-011, FR-018.
- S7. "https://artificialanalysis.ai/ esa u n pagina de ejemplo pero hay mas donde puede consultar": benchmark profiles. US6, FR-012, FR-013.

## Tasks

Task IDs are those of `specs/002-agentic-dispatcher/tasks.md`.

- [x] P2 Foundational T003-T005 (all S). Route: inline (about 80 lines, blocks both MVP units). Commit `9f8a93c`. RED 11 failing, GREEN 23/23.
- [x] P3 US2 T006-T010 (S3). Route: inline by Claude, in parallel with P4. RED 4 failing, GREEN 9/9; full suites green (124 node excl. catalog, 35 parity, 51 route-hint). Commit `ea96727`.
- [x] P4 US1 T011-T014 (S2). Route: delegated to gentle-shell on `openai-codex/gpt-6.2-sol` (writer reason: parallel unit with P3, disjoint surfaces; user rule "te lo repartis con gentle-shell"). `src/cli.ts` wiring done by parent before launch. RED 4 observed by the writer; seam check 128/128. `pi-table` parser added inline after the real run (RED 1, GREEN 129/129). Commit `ea96727`.
- [x] P5 US3 T015-T017 (S4). Route: delegated to gentle-shell on `openai-codex/gpt-6.2-sol` (parallel with the verifier fix and model_source work). Seam check 145/145, 35, 51. Commit `3e11b64`.
- [ ] P6 US6 T001, T018-T020 (S7). Not this session.
- [ ] P7 US4 T021-T022 (S5). Not this session.
- [ ] P8 US5 T002, T023-T025 (S6). Not this session.
- [ ] P9 Polish T026-T029 (S1). Not this session.

## Log

- L1 (2026-11-25) User request: "a ver a ver organicemos esto qu eno entiendo y creo que no esta trabajando como no quiero y estamos muy alejados de tener las cosas correctamente multi-agent-router quiero que si sea la aplicacion que controle todos mis agentes dependiendo que por ejemplo , quiero hacer algo en apex , como ODD hace ahcer tareas decirle a bueno yo me encargo de esto agy se encarga de esto, gentle-shell con chatgot se encarga de esto, que claude pueda decir pues mira para esta tarea mando a agy en neon por que es lo suficioente capaz de hacerla, depues otra tarea se la manda a gentle-shell con sol 6.2 ymientras tanto voy documentando con opencode , me entiendes cual es la idea? antes de iniciar algo verificar quue todo este actualizaod, que cada quien pueda elegir su modelo ,  me entiendes?"
- L2 (2026-11-25) User: "si, arranca con el plan podemos puedes guiarte por ejemplo de paginas como esta para saber que sirve para cada modelo o que haya una ofrma de consultar siempre los modelos que tenemos disponibles y podemos utilizar , por que a veces hay modelos que salen pero no podemos utilizar tambien que valida costo valor si hago una tarea que me va a gastar mucho mejor la hago con otro cosas asi quiero crear algo que sirva de verdad, que claude pueda decidir si es mejor mandar varios agentes, hacer un ajambre de agentes ccositas asi estamos en la era agentica necesitamos sacar todfo el provecho a esto https://artificialanalysis.ai/ esa u n pagina de ejemplo pero hay mas donde puede consultar me entiendes y cachas la idea?"
- L3 (2026-11-25) Spec Kit run: specify, plan, tasks, analyze (0 critical). Spec commit `ed66a56`. Prior-session role work committed separately as `97eeb64` (103 node tests, 35 parity, 51 route-hint green).
- L4 (2026-11-25) User: "si, aplicalas y arranca con el MVP". Remediation E1-E3, F1-F2 applied before the spec commit.
- L5 (2026-11-25) Spec drift found while writing T003: `tiers` already holds the agent tier lists, so the capability vocabulary is `capability_tiers`; data-model, research, tasks and spec updated.
- L6 (2026-11-25) US2 done inline. `model_source` is always `requested` for now: parsing the model an agent reports needs real agy/opencode output samples (costs quota); deferred, recorded as partial for T008. gentle-shell default model set to `openai-codex/gpt-6.2-sol`; `claude` agent enabled for explicit use (README notes it now shows as ready). P4 delegated to gentle-shell with `-m openai-codex/gpt-6.2-sol` (first dogfood of per-task model choice).
- L7 (2026-11-25) gentle-shell receipt: wrote src/catalog.ts, tests/catalog.test.ts, tests/fixtures/stub-models; RED observed; stopped by engram_save_guard on a project-less mem_save (bookkeeping only), so its suite run was unconfirmed. Parent seam check: 128 node, 35 parity, 51 route-hint green. Real `catalog --refresh` (24.7 s, under SC-002's 30 s): agy 28 usable with quota groups, opencode 9 free, claude 3 unverified; codex/gentle-shell showed only `openai-codex` because pi prints a provider/model table, fixed with the `pi-table` parser. Real refusal: `-a gentle-shell -m openai-codex/gpt-9-ghost` exits 2 "not in catalog".
- L8 (2026-11-25) MVP (P2 foundation already in `9f8a93c`; P3 + P4) committed as one work unit (about 380 authored lines). Risk: item 3 (shared `-a` path now refuses a model outside config `models` or the catalog; existing behavior preserved for agents without `models`, pinned by tests and parity suite).
- L9 (2026-11-25) User: "dale, sigue con el preflight mientras verifica no importa que gaste couta hazlo".
- L10 (2026-11-25) Independent verifier (`ask-agent -r verify`, agy gemini-4-neon-high) on ed66a56..ea96727: S2 PASS, regression vs 97eeb64 PASS on fresh cache; S3 FAIL, 1 blocker at src/run.ts:86-97 (catalog entry with source config and empty models blocked any -m on an agent without config models). One correction batch: probe added as regression test (RED observed, GREEN), modelProblem now trusts the catalog only when source is cli. Advisories: decimal pi-table context fixed (RED, GREEN); empty capability tier name rejected (test and fix written together, no RED observed); lines-first-field alpha-only ids and per-agent `source` placement left as documented. Scratch dirs reported by the verifier: /tmp/verify-base-llIdqv, /tmp/verify-cand-QI20jD, /tmp/verify-probe-L3iO7K.
- L11 (2026-11-25) Real samples (quota spent with user consent): agy JSON and opencode events report tokens, not the model; `claude -p --output-format json` reports modelUsage. Added claude-json parser and tokens_in/tokens_out (commit `fe3bedf`; T008 now complete for claude, requested-only for the others). Real probe: `-a claude -m haiku` recorded model claude-haiku-5-5, model_source reported.
- L12 (2026-11-25) Preflight receipt from gentle-shell incomplete (exited while its suites were queued). Parent seam check green; real `ask-agent preflight`: 26.2 s (under SC-003), all versions current except agy unknown (no latest source), benchmarks not configured, exit 0. Commit `3e11b64`. Next: RDD review of ed66a56..3e11b64 (high_risk), then P6 benchmarks.
