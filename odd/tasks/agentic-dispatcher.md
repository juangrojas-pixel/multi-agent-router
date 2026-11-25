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
- [x] P5b Hardening from RDD advisories (S2-S4), inline. Commits `c94a911` and (catalog part) `7dd32e6`: stale catalog gate (a new model stays refused until `catalog --refresh`), list timeout cap in preflight (later removed in `7dd32e6`: it overrode gentle-shell's 120 s list timeout; listings stay bounded by `list_models.timeout_seconds`), quota worker failure marking every agent, cache omitting newly enabled agents, newer-than-latest version shown as unknown, model check only on named agents (not fallbacks).
- [x] P6 US6 T001, T018-T020 (S7). Route: delegated to gentle-shell on `openai-codex/gpt-6.2-sol`. Commit `7dd32e6`.
- [x] P7 US4 T021-T022 (S5). Route: delegated to agy on `gemini-4-neon-high` (catalog: frontier for code, Gemini quota 96%). Commit `2c37818`; effort grouping `57c61d5`.
- [x] P8 US5 T002, T023-T025 (S6). Route: gentle-shell returned empty answers twice (21 s, cause unknown), moved to agy `gemini-4-neon-high`; it stopped for two out-of-surface changes the parent applied (ASK_AGENT_NO_FALLBACK, batch_id). Commit `64ad4e2`.
- [x] P8b US7 herdr-server backend, inline. Commit `2a481c3` (kept for herdr-server setups; the user's app is herdr-core).
- [x] P8c hc terminals under the orchestrator + auto hc backend + terminal banner, inline. Commits `c7d1481`, `6b71100`.
- [x] P10 US8 live interactive backend. Route: agy `gemini-4-neon-high` after a parent spike. Commit `41d9655`; placeholder and guidance fixes `e93c41d`.
- [x] P9 guidance + delegate skill, inline. Commit `a07164f`.
- [x] P11 Follow-up from the four RDD reviews (non-blocking WARNING findings listed in L19). Route: `ask-agent dispatch` batch p11, four parallel writers with disjoint surfaces (P11a gentle-shell gpt-6.2-sol benchmarks; P11b agy neon-high catalog/cli/run; P11c agy neon-high dispatch/herdr; P11d gentle-shell gpt-6.2-sol live/hc/agents.json); docs findings and two parent fixes inline. See L20. Commits: `8cd2b10` (P11a), `abeb461` (P11b + env leak), `3d6fa69` (P11c), `3404f25` (P11d + blocked wait), docs in the closing commit.

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
- L13 (2026-11-25) RDD review of ed66a56..3e11b64 (user granted; lenses risk, resilience, readability, reliability): approved, receipt acknowledged (lineage review-a223e81b57ab946c). Non-blocking findings, kept as P5b follow-up:
  - R2-agy-hardcoded-quota (readability, WARNING) src/catalog.ts:104
  - R2-duplicated-list-runners (readability, SUGGESTION) src/catalog.ts:90-101
  - R2-model-check-scope (readability, WARNING) src/cli.ts:216-219
  - R2-modelproblem-naming (readability, SUGGESTION) src/run.ts:90-91
  - R2-preflight-failed-outdated-names (readability, WARNING) src/preflight.ts:68-69
  - R2-preflight-list-timeout-cap (readability, WARNING) src/catalog.ts:95
  - R2-test-message-mismatch (readability, SUGGESTION) tests/preflight.test.ts:119
  - R2-version-newer-unknown (readability, SUGGESTION) src/preflight.ts:30
  - R3-cache-omits-new-agents (reliability, WARNING) src/catalog.ts:184-185
  - R3-claude-tokens-in (reliability, SUGGESTION) src/agents.ts:55
  - R3-fallback-unchecked (reliability, WARNING) src/cli.ts:216-219
  - R3-preflight-timeout-cap (reliability, WARNING) src/catalog.ts:95
  - R3-quota-worker-fails-all (reliability, WARNING) src/catalog.ts:103-107
  - R3-stale-catalog-gate (reliability, WARNING) src/run.ts:90-95
  - R3-unverified-test-path (reliability, SUGGESTION) tests/run-record.test.ts:98-105
  - R3-version-newer-unknown (reliability, WARNING) src/preflight.ts:29-30
  - R4-preflight-list-timeout-cap (resilience, WARNING) src/catalog.ts:95
  - R4-stale-catalog-gate (resilience, WARNING) src/run.ts:88-96
- L14 (2026-11-25) User: "si, sigue con P6 y P7 y la p5b creo que la nombraste tambien".
- L15 (2026-11-25) P5b inline: stale catalog gate now refreshes the agent once (RED, GREEN), fallbacks that cannot run -m are skipped (RED, GREEN), newer-than-latest is current (RED, GREEN), newly enabled agent listed from cache (RED, GREEN); crashed quota worker resolves empty and preflight list timeout uncapped have no deterministic RED (written with the fix). An auto-refresh on agents without list_models overwrote a CLI catalog with config data in an existing test; restricted to agents with list_models.
- L16 (2026-11-25) P6 receipt from gentle-shell again ended with suites "running" (second time: it backgrounds suites and ends its turn); parent seam check 150/150, 35, 51. First real refresh: lmarena failed (shared 15 s timeout across 21 HF pages plus other sources); fixed with one timeout per request, real refresh fresh in 24.1 s. Real data: LMArena ranks GPT-6.2 Sol 109 in coding (preference-based), so it measures `light`; Sonnet 5.5 rank 28 -> standard; Neon/Carbon/Opus frontier. Open question for the user: declared tiers for GPT (config `models.<id>.tier`) or an agentic-coding source (Epoch SWE-bench) before P7 routes on these tiers.
- L17 (2026-11-25) User decisions: "las dos, primero declara tiers y despues suma Epoch" (declared gpt-6.2-sol `1e78582`, Epoch FrontierSWE `7888f63`); "dale, agrupa los esfuerzos y sigue" (`57c61d5`); opencode first for docs (`93a103e`); "quiero poder tambien ver al lado izquierdo cuando claude manda otro agente" and "el modelo interactivo me gustaria para ver que esta haciendo cada agente por que esa es como el razon ser" -> live backend as an option ("pero como opcional").
- L18 (2026-11-25) Findings: the Herdr app is a herdr-core client (HC_TERMINAL_ID), so hc terminals parented to the orchestrator show under it; Herdr detects agent icon/status only for interactive TUIs; hc core PATH lacks ~/.npm-global/bin (live resolves absolute paths); router substituted {model} inside prompts (fixed `e93c41d`). Live real run: agy flash low answered in 19 s, terminal stays open with status done. Quota: the 5 h Gemini window moved -0.47% for the -p run and regenerated (+0.41%) during the live run; one small task costs less than the regeneration noise, so the live overhead could not be measured and is expected to be the appended instruction plus one file write.
- L19 (2026-11-25) User: "hazlos por partes". The 3e11b64..57c4bbd review exceeded the reviewer context budget, so it ran as four slices in temporary worktrees (granted each time). Slice 1 (3e11b64..1e78582) approved, lineage review-e680a6ea204b8b20; slice 2 (..7888f63) approved, review-acca0f6e51ef1053; slice 4 (..57c4bbd) approved, review-359fb1ee63ccbfe2; slice 3 (..64ad4e2) correction_required: refuter corroborated CRITICAL R1-client-policy-fallback-bypass (a client task with fallback: true validated only the named agent). One bounded correction (forecast 25 lines, actual 25; RED, GREEN), targeted validation approved, review-613231c36b1535f7; fix cherry-picked as `ff71a80`. Several reviewer and refuter captures first failed on the Claude 5-hour limit and were relaunched only for the slots STATUS reoffered. Suites after the fix: 206 node, 35 parity, 51 route-hint. Non-blocking warnings kept for P11:
  - [s1] R1-unbounded-hf-pagination | risk | WARNING | src/benchmarks.ts:136-150
  - [s1] R2-arraymodels-implicit-parser | readability | WARNING | src/benchmarks.ts:102-108
  - [s1] R2-cached-catalog-spawns-cli | readability | WARNING | src/catalog.ts:202-208
  - [s1] R2-p5b-status-stale | readability | WARNING | odd/tasks/agentic-dispatcher.md:27
  - [s1] R2-preflight-timeout-cap-removed | readability | WARNING | src/catalog.ts:98
  - [s1] R3-hf-pagination-untested | reliability | WARNING | src/benchmarks.ts:135-151
  - [s1] R3-refresh-on-miss-failure-path | reliability | WARNING | src/cli.ts:222-225
  - [s1] R4-empty-arena-marked-fresh | resilience | WARNING | src/benchmarks.ts:80-96
  - [s1] R4-implicit-refresh-degrades-cache | resilience | WARNING | src/cli.ts:220-226
  - [s1] R4-preflight-list-timeout-uncapped | resilience | WARNING | src/catalog.ts:98
  - [s1] R4-serial-benchmark-then-catalog-refresh | resilience | WARNING | src/catalog.ts:173-175
  - [s2] R2-epoch-id-suffix-regex | readability | WARNING | src/benchmarks.ts:195
  - [s2] R2-merge-policy-condition | readability | WARNING | src/benchmarks.ts:300-304
  - [s2] R2-zip-basename-collapse | readability | WARNING | src/benchmarks.ts:135-136
  - [s2] R2-zip-magic-offsets | readability | WARNING | src/benchmarks.ts:116-158
  - [s2] R3-epoch-missing-bands | reliability | WARNING | src/benchmarks.ts:204
  - [s2] R3-epoch-score-scale | reliability | WARNING | src/benchmarks.ts:198
  - [s2] R3-merge-first-wins | reliability | WARNING | src/benchmarks.ts:300-306
  - [s2] R3-refusal-masks-quota | reliability | WARNING | src/run.ts:193-194
  - [s2] R4-model-refusal-masks-quota | resilience | WARNING | src/run.ts:193-194
  - [s3] R2-docs-role-reorder-unexplained | readability | WARNING | agents.json:138
  - [s3] R2-herdr-split-cwd-tautology | readability | WARNING | tests/herdr-backend.test.ts:36
  - [s3] R2-stale-task-tracking | readability | WARNING | specs/002-agentic-dispatcher/tasks.md:113-114
  - [s3] R3-dispatch-child-execargv | reliability | WARNING | src/dispatch.ts:216
  - [s3] R3-dispatch-concurrency-nan | reliability | WARNING | src/dispatch.ts:279
  - [s3] R3-dispatch-depth-guard-cleared | reliability | WARNING | src/dispatch.ts:210
  - [s3] R3-dispatch-receipt-agent-misattributed | reliability | WARNING | src/dispatch.ts:296
  - [s3] R3-herdr-pane-run-unchecked | reliability | WARNING | src/herdr.ts:91
  - [s3] R3-herdr-timeout-leaves-agent-running | reliability | WARNING | src/herdr.ts:96-100
  - [s3] R4-herdr-control-calls-unbounded | resilience | WARNING | src/herdr.ts:22-33
  - [s3] R4-herdr-pane-run-failure-ignored | resilience | WARNING | src/herdr.ts:91-103
  - [s3] R4-herdr-timeout-no-kill-escalation | resilience | WARNING | src/herdr.ts:96-100
  - [s4] R1-001 | risk | WARNING | src/live.ts:125-131
  - [s4] R1-002 | risk | WARNING | agents.json:390-396
  - [s4] R2-live-args-duplicates-commandArgs | readability | WARNING | src/live.ts:45-59
  - [s4] R2-live-capture-address-duplicated | readability | WARNING | src/live.ts:10-26
  - [s4] R2-tasks-left-unchecked | readability | WARNING | specs/002-agentic-dispatcher/tasks.md:119-120
  - [s4] R3-live-effort-dropped | reliability | WARNING | agents.json:190-193
  - [s4] R3-live-empty-answer-success | reliability | WARNING | src/live.ts:233-241
  - [s4] R3-live-get-failure-aborts | reliability | WARNING | src/live.ts:71-84
  - [s4] R3-live-idle-after-send-race | reliability | WARNING | src/live.ts:231-241
  - [s4] R3-terminal-name-truncation-collision | reliability | WARNING | src/hc.ts:62-66
  - [s4] R4-live-blocked-orphan-task | resilience | WARNING | src/live.ts:199-210
  - [s4] R4-live-hc-transient | resilience | WARNING | src/live.ts:182-197
  - [s4] R4-live-idle-false-success | resilience | WARNING | src/live.ts:231-238
- L20 (2026-11-25) User: "dale, sigue con P11". Only slugs and locations survived the burned review artifacts, so each writer first judged each finding, then fixed real ones test-first. Outcomes: P11a fixed 9 (HF pagination capped at 100 pages and tested, empty LMArena refresh keeps the old snapshot as stale, ambiguous zip basenames rejected, named zip offsets, Epoch without bands publishes scores with no measured tier), no-change 2 (first measured tier wins by design and is tested; Epoch scale already enforced). P11b fixed 6 (benchmarks and catalog refresh run concurrently; a failed implicit refresh keeps the cached CLI entry; refusal pattern narrowed to `requires usage credits` and quota wording wins, so a real quota exhaustion cools down), no-change 1 (preflight list cap removed on purpose in P5b). P11c fixed 6 (child router keeps execArgv; receipt names the agent that answered; herdr `pane run` failure returns at once; timeout escalates ctrl+c, SIGTERM, SIGKILL; control calls bounded; tautological test), no-change 2 (concurrency already validated by config; depth guard already refuses nesting). P11d (receipt without per-finding lines; diff read by the parent): live args reuse `commandArgs`, hc `capture`/`address` shared, live gets agy effort and extra args, claude live no longer auto-answers the folder-trust dialog (R1-002), empty answer and stale idle are not success, transient `hc get` failures are retried, terminal names unique per process. Parent changes: P11d killed a task blocked after send; that defeats the live mode's purpose (watch and steer), so a post-send block now notes once and keeps waiting for the user until the timeout, which still stops the task (RED on the previous code, GREEN). P11b found `ASK_AGENT_NO_FALLBACK`/`ASK_AGENT_BATCH_ID` leaking from dispatch into the agent's environment (it broke the agent's own test run): new `agentEnv()` in `src/agents.ts` used by subprocess, hc and herdr; test helper strips them too (RED, GREEN). Docs: README explains the docs role order, spec tasks T001-T033 checked except T029, P5b line corrected. Suites: 228 node, 35 parity, 51 route-hint.
- L21 (2026-11-25) RDD review of the P11 range (c44f13c..d8c8d19, 950 lines, four lenses, granted) approved without correction, lineage review-24161296e1582e90, acknowledged. 15 non-blocking advisories (no follow-up task opened): R1-001 src/herdr.ts:146-163; R1-002 and R2-dispatch-stderr-attribution src/dispatch.ts:239-246 (agent read from child stderr); R2-catalog-fetch-keepcached-flow src/catalog.ts:187-201; R2-herdr-capture-divergent-duplicate src/herdr.ts:25; R2-herdr-timeout-escalation-inline src/herdr.ts:146-166; R2-live-args-opaque-commandArgs-call src/live.ts:25-30; R2-live-finish-empty-sentinel src/live.ts:226-230; R3-001 and R4-live-get-failure-unbounded-retry src/live.ts:162-166 (hc get failures retried until the deadline); R3-002 src/live.ts:217-223; R3-003 src/run.ts:12-14; R3-004 and R4-herdr-pane-run-timeout-orphan src/herdr.ts:134-140; R3-005 src/dispatch.ts:223.
- L22 (2026-11-25) User: "dale, actualiza pi y corre el quickstart". `pi update self`: 1.6.0 -> 1.6.1 (pi warns this npm install does not pin dependencies and suggests `curl -fsSL https://pi.dev/install.sh | sh`; not run). Quickstart (T029): automated 230 node, 35 parity green; 1 preflight ready, exit 0; 2 `catalog --refresh` 24 s, usable models cross-checked against `agy models`, `opencode models`, `pi --list-models`: 0 not listed; 3 candidates cheapest first (claude/haiku 0.04), none over the ceiling; 4 dispatch opencode + agy hydrogen-low: two receipts, two files, runs.jsonl with batch_id and task_id (reason null because the batch omitted it; data-model and quickstart now name `reason`); 5 overlapping writes exit 2, no agent started. Two bugs found and fixed test-first: LMArena intermittently stale (timeout: the Hugging Face filter endpoint answers slowly under six parallel pages, /rows answers 429; pages now go three at a time and a failed page is retried once after 1 s; timeouts reported as `timeout`), commit `303b5d7`; piped output truncated (`catalog --json | jq` got 81920 of 110304 bytes because process.exit dropped queued stdout; the CLI now exits after stdout drains), commit `4353acf`.
