# role-based-routing

Objective: declare named roles in config (role -> agents -> model -> effort), run tasks by role with fallback, make the orchestrator a role any agent can hold, and keep site policy in a private file; reimplemented in TypeScript next to the untouched bash router.
Branch: `feat/router`. Delivery strategy: `ask-on-risk`. Forecast: about 1,200 authored lines plus tests, over the 400-line budget, so it ships as one commit per phase.
Test runner: `node --test tests/` and `ASK_AGENT_BIN=bin/ask-agent-ts bash tests/ask-agent.test.sh`; also `tests/route-hint.test.sh`.

## Specs

The full specification is `specs/001-role-based-routing/` (spec.md, plan.md, research.md, data-model.md, contracts/cli.md, quickstart.md, tasks.md) under `.specify/memory/constitution.md`. Those files are the authority; this list indexes them with the user's words.

- S1. "claude va a hacer el que orquesta, agy y gentle-shell pueden hacer copdigo": named roles in config, run by role. spec.md Story 1, FR-001 to FR-004, FR-009.
- S2. Fallback inside a role when an agent has no quota, times out or fails, recorded in history. spec.md Story 2, FR-005, FR-006.
- S3. List roles and stop early on config mistakes naming the entry. spec.md Story 3, FR-007, FR-008.
- S4. "que se adapte a cualquier agente": orchestrator is a role; guidance generated from roles; two working adapters (user chose option "B"): Claude Code and gentle-shell. spec.md Story 4, FR-010 to FR-012, FR-015.
- S5. Site policy in a private file outside the repository. spec.md Story 5, FR-013, FR-014.
- S6. "nos basamos en el plugin que tengo": the bash `bin/ask-agent` stays as fallback until the new one matches it. FR-016, constitution V.
- S7. Scope: "hagamosla para el usp mio". Out of scope: open source, API key, ACP, interactive menu, gentle-ai RDD roles.

## Tasks

Task IDs are those of `specs/001-role-based-routing/tasks.md`. One line per phase.

- [ ] P1-P2 Setup and foundation, T001-T010 (S6). Route: delegated (context backstop: long parent session). Commit: pending
- [ ] P3 Run by role, T011-T015 (S1). Route: pending. Commit: pending
- [ ] P4 Fallback in a role, T016-T017 (S2). Route: pending. Commit: pending
- [ ] P5 List and validate, T018-T021 (S3). Route: pending. Commit: pending
- [ ] P6 Orchestrator guidance and adapters, T022-T028 (S4). Route: pending. Commit: pending. Risk item 3 (hooks others consume)
- [ ] P7 Private policy merge, T029-T031 (S5). Route: pending. Commit: pending
- [ ] P8 Port remaining commands, switch, move client text, T032-T039 (S5, S6). Route: pending. Commit: pending. T037 and T039 need the user's explicit go-ahead

## Log

- L1 (2026-11-10, user, original request verbatim): "oye lo de multi agent router lo podemos avelucionar para que se adapte a cualquier agente o sea hacer una app de typescript, rust , python no lo se algun lenguaje de programacion que maneje los hilos de lo que quiero logrrar actualmente no veo que existe algun aapp que permita hacer eso, por y que sirva con las suscripciones y que le podamos decir que hace cada uno, qu esi en gentle-ai puedo decir por cada quien que se encargue de que pero no existe alguna herrmienta que yo le pueda decir mira claude va a hacer el que orquesta, agy y gentle-shell pueden hacer copdigo , esto es un ejemplo no existe algo asi o si?"
- L2 (2026-11-10, user): "hagamosla para el usp mio si me funciona ya depues lo hago". Personal use first; open source and API key deferred.
- L3 (2026-11-10, user): "como funcionaria mejor , en typescript no?" Decision: TypeScript.
- L4 (2026-11-10, user): constitution accepted ("si"); orchestrator scope "B" (a second orchestrator must work).
- L5 (2026-11-10): analysis found two critical ordering defects (adapters calling a command the bash router lacks; client preambles removed while bash is still in use). User approved the fixes ("si"); tasks renumbered to T001-T039.
- L6 (2026-11-10): evidence. Node 24.13 runs `.ts` files and `node --test` directly (checked). `bin/ask-agent:305` hard-codes each agent's argument shape. `date -r EPOCH` at `bin/ask-agent:77,208` fails under GNU date; not fixed in bash, new code formats times itself.
- Next step: Phases 1 and 2.
