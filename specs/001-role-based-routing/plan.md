# Implementation Plan: Role-Based Agent Routing

**Branch**: `feat/router` (spec directory `001-role-based-routing`) | **Date**: 2026-11-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-role-based-routing/spec.md`

## Summary

Let the user declare named roles in config (role, agents in order, model, effort) and run
tasks by role, with fallback, listing and loud validation; make the orchestrator a role any
agent can hold, with guidance generated from the roles and delivered by two thin adapters
(Claude Code and gentle-shell); move site-specific policy to a private file.

Technical approach: a TypeScript reimplementation of the router run directly by Node with no
build step and no dependencies, placed next to the untouched bash router. Commands not yet
ported are handed to the bash script, and the existing bash test suite is the parity
contract. How an agent is started moves from a hard-coded `case` into config.

## Technical Context

**Language/Version**: TypeScript, executed directly by Node 24 (erasable syntax only)

**Primary Dependencies**: none at runtime; Node built-ins only. `jq` remains a dependency of
the bash fallback and of `bin/route-hint`

**Storage**: JSON files. Config: `agents.json` plus optional private `policy.json`. State:
`cooldown.json`, `runs.jsonl`, `last/<agent>.json` under the existing cache directory

**Testing**: `node:test` for new tests; `tests/ask-agent.test.sh` (35 checks) as parity
contract, parametrized by `ASK_AGENT_BIN`; `tests/route-hint.test.sh` (33 checks). All tests
use stub agents declared through config

**Target Platform**: Linux, single user, one machine

**Project Type**: CLI

**Performance Goals**: router overhead before the agent starts under 300 ms; `roles` listing
under 10 s including the readiness check (SC-005)

**Constraints**: same flags, output and exit status for existing commands; state files stay
compatible with the bash router and `route-hint` while both exist; no real agent CLI in tests

**Scale/Scope**: about 5 agents, about 10 roles, one config file. Roughly 1,200 lines of
TypeScript plus tests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the design complies |
|---|---|---|
| I. Official CLIs only | PASS | The router only starts each vendor's CLI with arguments; it reads no credential |
| II. Config is the source of truth | PASS | Roles, agent start shape, models and effort levels are config; the hard-coded per-agent `case` is removed |
| III. Host-agnostic core | PASS | `guidance` output names no product; adapters deliver text and call the CLI |
| IV. Private policy out of the repo | PASS | `policy.json` under the user config directory; client text moves out of `agents.json` |
| V. Parity before replacement | PASS | bash router untouched; unported commands are handed to it; symlink moves last |
| VI. Test-first through the CLI | PASS | every story starts with failing CLI tests on stub agents |
| VII. Fail loudly, fall back by config | PASS | validation before any start; role order is the only fallback; every attempt recorded |

Post-design re-check: PASS, no violations, Complexity Tracking empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-role-based-routing/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/cli.md
└── tasks.md            # created by /speckit-tasks
```

### Source Code (repository root)

```text
bin/
├── ask-agent           # bash router, untouched: the fallback
├── ask-agent-ts        # new entry: runs src/cli.ts with node
└── route-hint          # existing hook; no-match text now comes from `guidance`
src/
├── cli.ts              # argument parsing, dispatch, hand-off of unported commands to bash
├── config.ts           # load, merge private policy, validate
├── roles.ts            # role resolution, readiness, listing
├── agents.ts           # argument templates, built-in defaults, output parsers
├── run.ts              # timeout, process-group kill, fallback loop
├── state.ts            # cooldown file and lock, run history, last-run files
└── guidance.ts         # orchestrator guidance text
adapters/
└── gentle-shell/orchestrate   # launcher: gentle-shell with the guidance appended
hooks/
└── register.ts         # Claude Code adapter; reads `ask-agent guidance`
tests/
├── ask-agent.test.sh   # parity contract, gains ASK_AGENT_BIN
├── route-hint.test.sh
├── fixtures/           # stub agents and sample configs
└── *.test.ts           # node:test suites, one per story
agents.json             # generic defaults and example roles only
```

**Structure Decision**: single CLI project. New code lives in `src/` and is run in place by
Node; `bin/ask-agent-ts` is the only new executable. The bash router and its tests stay where
they are so the fallback and the parity contract are never out of reach.

## Delivery order

1. Foundation: config load, merge and validation; agent start driven by config; default ask
   by agent and tier ported and passing the parity suite; other commands handed to bash.
2. Story 1: run by role.
3. Story 2: fallback inside a role, with history.
4. Story 3: `roles` listing and the remaining validation rules.
5. Story 4: `guidance`, Claude Code adapter switched to it, gentle-shell adapter.
6. Story 5: private policy file loading and merge. Nothing is removed from the repository
   config yet, because the bash router in daily use does not read the private file.
7. Port the commands still handed to bash (`status`, `reset`, `runs`, `parallel`,
   `--backend hc`); then the symlink switch, done by the user's decision.
8. Last: create the user's private file with the client text, confirm agents get the same
   preambles, and only then replace that text in the repository config with generic versions.

Until the symlink switch, adapters call the new router by path and fall back to
`routing.general`, so the hooks keep working while `ask-agent` on PATH is still bash.

Stories 1 and 2 give a usable result on their own (roles with fallback, called by hand).

## Risks

- Item 3, contracts others consume: `agents.json` gains keys and its client text moves to the
  private file. `route-hint` and `register.ts` read that file today. Mitigation: additive
  keys, the private merge reproduces today's values, both hook test suites run on each step.
- Item 4, concurrency: the cooldown file is shared by two implementations and by parallel
  runs. Mitigation: keep the same lock directory protocol and atomic rename.
- gentle-shell as orchestrator depends on `--append-system-prompt` reaching pi through the
  wrapper; confirmed from help output only, proven in quickstart step 4.

## Complexity Tracking

No constitution violations to justify.
