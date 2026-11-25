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

- [ ] P2 Foundational T003-T005 (all S). Route: inline (about 80 lines, blocks both MVP units).
- [ ] P3 US2 T006-T010 (S3). Route: inline by Claude, in parallel with P4.
- [ ] P4 US1 T011-T014 (S2). Route: delegated to gentle-shell (writer reason: parallel unit with P3, disjoint surfaces; user rule "te lo repartis con gentle-shell"). `src/cli.ts` wiring done by parent before launch.
- [ ] P5 US3 T015-T017 (S4). Not this session.
- [ ] P6 US6 T001, T018-T020 (S7). Not this session.
- [ ] P7 US4 T021-T022 (S5). Not this session.
- [ ] P8 US5 T002, T023-T025 (S6). Not this session.
- [ ] P9 Polish T026-T029 (S1). Not this session.

## Log

- L1 (2026-11-25) User request: "a ver a ver organicemos esto qu eno entiendo y creo que no esta trabajando como no quiero y estamos muy alejados de tener las cosas correctamente multi-agent-router quiero que si sea la aplicacion que controle todos mis agentes dependiendo que por ejemplo , quiero hacer algo en apex , como ODD hace ahcer tareas decirle a bueno yo me encargo de esto agy se encarga de esto, gentle-shell con chatgot se encarga de esto, que claude pueda decir pues mira para esta tarea mando a agy en neon por que es lo suficioente capaz de hacerla, depues otra tarea se la manda a gentle-shell con sol 6.2 ymientras tanto voy documentando con opencode , me entiendes cual es la idea? antes de iniciar algo verificar quue todo este actualizaod, que cada quien pueda elegir su modelo ,  me entiendes?"
- L2 (2026-11-25) User: "si, arranca con el plan podemos puedes guiarte por ejemplo de paginas como esta para saber que sirve para cada modelo o que haya una ofrma de consultar siempre los modelos que tenemos disponibles y podemos utilizar , por que a veces hay modelos que salen pero no podemos utilizar tambien que valida costo valor si hago una tarea que me va a gastar mucho mejor la hago con otro cosas asi quiero crear algo que sirva de verdad, que claude pueda decidir si es mejor mandar varios agentes, hacer un ajambre de agentes ccositas asi estamos en la era agentica necesitamos sacar todfo el provecho a esto https://artificialanalysis.ai/ esa u n pagina de ejemplo pero hay mas donde puede consultar me entiendes y cachas la idea?"
- L3 (2026-11-25) Spec Kit run: specify, plan, tasks, analyze (0 critical). Spec commit `ed66a56`. Prior-session role work committed separately as `97eeb64` (103 node tests, 35 parity, 51 route-hint green).
- L4 (2026-11-25) User: "si, aplicalas y arranca con el MVP". Remediation E1-E3, F1-F2 applied before the spec commit.
