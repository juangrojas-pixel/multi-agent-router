# Tasks: Role-Based Agent Routing

**Input**: Design documents from `/specs/001-role-based-routing/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli.md, quickstart.md

**Tests**: required by Constitution VI. Each story's tests are written first and must fail
before its implementation. Tests go through the CLI and use stub agents from
`tests/fixtures/`; no real agent CLI is ever called.

**Runner**: `node --test tests/*.test.ts` and `ASK_AGENT_BIN=bin/ask-agent-ts bash tests/ask-agent.test.sh`

## Phase 1: Setup

- [x] T001 Create `src/`, `adapters/gentle-shell/`, `tests/fixtures/` and the executable `bin/ask-agent-ts` that runs `src/cli.ts` with `node`, resolving its own real path through symlinks
- [x] T002 [P] Add stub agents to `tests/fixtures/`: `stub-ok` (echoes its last argument), `stub-quota` (prints a quota error and exits non-zero), `stub-fail` (exits 1), `stub-slow` (sleeps past the timeout), `stub-argv` (prints every argument it received, one per line), plus `tests/fixtures/helpers.ts` that builds a scratch config, sets `ASK_AGENT_CONFIG`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME` to `mktemp -d` paths and runs the CLI returning stdout, stderr and exit status
- [x] T003 [P] Make `tests/ask-agent.test.sh` run the binary named by `ASK_AGENT_BIN` (default `bin/ask-agent`), with no other change to its 35 checks

## Phase 2: Foundational (blocks every story)

- [x] T004 Write failing tests in `tests/foundation.test.ts`: default ask by `-a` and by `-t` returns the stub's answer on stdout with exit 0; `-t` with `-a` exits 2; missing config exits 2; a call with `ASK_AGENT_DEPTH` set exits 2; an unported command (`status`) produces the same output as `bin/ask-agent`
- [x] T005 Implement config loading in `src/config.ts`: read `ASK_AGENT_CONFIG` or the repository `agents.json`, return typed config, and report unreadable or invalid JSON as `[ask-agent] config: <path>: <message>` with exit 2
- [x] T006 Implement agent start shape in `src/agents.ts`: `args` template with `{prompt}`, `{timeout}`, `{model_args}`, `{effort_args}`, `{extra_args}`; `model_args` and `effort_args` fragments added only when a value is set; `output` parsers `text`, `agy-json` (answer is `.response` only when `.status=="SUCCESS"`), `opencode-events` (concatenated `.part.text` of `type=="text"`, emptied by any `type=="error"`); built-in defaults for ids `codex`, `agy`, `opencode`, `gentle-shell` equal to `bin/ask-agent:305-334`; `prompt_preamble` joined to the prompt with a blank line
- [x] T007 Implement state in `src/state.ts`: `cooldown.json` as `{"<agent id>": <until epoch>}` written under the `cooldown.json.lock` directory lock (stale after 30 s) with temp file then rename; `runs.jsonl` records with the existing fields; `last/<agent>.json`; all under `${XDG_CACHE_HOME:-~/.cache}/multi-agent-router/`
- [x] T008 Implement the run engine in `src/run.ts`: start the agent in its own process group with stdin from `/dev/null`, enforce `timeout_seconds` (default 600) with TERM then KILL to the group, detect quota errors with the existing pattern and set cooldown for `cooldown_seconds`, treat exit 0 with an empty answer as failure, and try candidates in order until one succeeds
- [x] T009 Implement `src/cli.ts`: parse the existing flags exactly as `contracts/cli.md` "Existing" states, run the default ask by agent (named agents then each one's `fallback`, deduplicated) and by tier, refuse nested calls, and hand `parallel`, `status`, `reset`, `runs` and `--backend hc` to `bin/ask-agent` with the original arguments
- [x] T010 Run `ASK_AGENT_BIN=bin/ask-agent-ts bash tests/ask-agent.test.sh` and `node --test tests/*.test.ts`; fix differences until both pass

**Checkpoint**: the new entry behaves like the bash router for everything it accepts.

## Phase 3: User Story 1 - Run a task by role (P1) MVP

**Goal**: `ask-agent -r ROLE` runs the task on the role's agent with its model and effort.

**Independent test**: one role pointing at `stub-argv`; run by role; the stub got the task.

- [x] T011 [US1] Write failing tests in `tests/role-run.test.ts` for spec Story 1 scenarios 1 to 5: run by role reaches the agent; role `model` and `effort` appear in the stub's arguments through `model_args` and `effort_args`; a role with only an agent adds neither; unknown role exits 2 with `unknown role: NAME (configured: ...)` and starts no agent; `-a` and `-t` calls are unchanged; `-r` with `-a`, `-t` or `-m` exits 2; no roles configured exits 2 with `no roles configured`
- [x] T012 [US1] Add `roles` to the config type in `src/config.ts`: each role has `description`, `agents` (at least one; each entry an agent id string or `{ "agent", "model"?, "effort"? }`), optional `model`, optional `effort`
- [x] T013 [US1] Implement role resolution in `src/roles.ts`: entries in order with duplicates dropped; the entry's own model and effort win over the role default, which wins over the agent's `model`
- [x] T014 [US1] Add `-r` / `--role` to `src/cli.ts` with the messages and exit status in `contracts/cli.md` "Run by role", and record `role` in each `runs.jsonl` line written by `src/state.ts`
- [x] T015 [US1] Document `-r` in the `--help` text of `src/cli.ts` and in `README.md`, and add two example roles to `agents.json`

**Checkpoint**: roles are usable by hand.

## Phase 4: User Story 2 - Fallback inside a role (P1)

**Goal**: when a role's first agent cannot work, the next one takes the task and the history shows it.

**Independent test**: a role with `stub-quota` then `stub-ok`; the answer comes from the second.

- [x] T016 [US2] Write failing tests in `tests/role-fallback.test.ts` for spec Story 2 scenarios 1 to 4: first agent in cooldown is skipped; a quota error mid-run sets cooldown and retries on the next; `stub-fail` and `stub-slow` fall through; every entry unavailable exits 2 with one reason line per entry and `role NAME: no agent could run`; `runs.jsonl` has one line per attempt with `role`, `agent` and `exit`; each step prints `role NAME: AGENT failed (REASON), trying NEXT` on stderr; a per-agent `fallback` list is not used for role runs
- [x] T017 [US2] Extend `src/roles.ts` and `src/run.ts` so role runs skip entries that are disabled, not installed or in cooldown (recording the reason), fall through on quota, timeout, failure or empty answer, and emit the stderr lines above

**Checkpoint**: roles survive an exhausted agent.

## Phase 5: User Story 3 - List roles and catch mistakes (P2)

**Goal**: `ask-agent roles` shows what each role resolves to; config mistakes stop every command early.

**Independent test**: one valid role and one naming a missing agent; the error names the bad one.

- [x] T018 [US3] Write failing tests in `tests/roles-list.test.ts` and `tests/config-validate.test.ts`: the listing prints tab-separated `role agent model effort ready reason` per entry with `-` for unset values, an `orchestrator AGENT` first line when configured, and exit 0 when some entries are not ready; each validation rule in `data-model.md` exits 2 with `config: KEY: MESSAGE` naming the listed key before any agent starts (role with no agents; entry naming an unknown agent; model not in the agent's `models`; effort on an agent with no `effort_levels`; effort level not in `effort_levels`; unknown `orchestrator.agent`; unknown `routing.rules[i].role`; unknown `agents.<id>.output`); a duplicate agent in a role is not an error; the agent named in `orchestrator.agent` may also appear in a role and is listed and run like any other entry
- [x] T019 [US3] Implement the validation rules in `src/config.ts`, run before any command, adding `models`, `effort_levels`, `orchestrator` and `routing.rules[].role` to the config type
- [x] T020 [US3] Implement readiness and the `roles` command in `src/roles.ts` and `src/cli.ts`: reasons `disabled`, `not installed`, `cooldown until HH:MM` (time formatted in code, not with `date -r`)
- [x] T021 [US3] Document `roles` and the new agent keys (`args`, `model_args`, `effort_args`, `output`, `models`, `effort_levels`) in `--help` and `README.md`

**Checkpoint**: hand-edited config is safe.

## Phase 6: User Story 4 - Any agent can orchestrate (P2)

**Goal**: guidance generated from the roles, delivered by two adapters with no logic of their own.

**Independent test**: change a role description; `ask-agent guidance` reflects it.

- [ ] T022 [US4] Write failing tests in `tests/guidance.test.ts`: one line per role with its description and the call form `ask-agent -r NAME -C <dir> "<task>"`; `routing.notes` appended when set; the text contains no orchestrator product name whichever agent `orchestrator.agent` names; no roles prints only the notes with exit 0; a call with `ASK_AGENT_DEPTH` set to `-r` is still refused
- [ ] T023 [US4] Implement `src/guidance.ts` and the `guidance` command in `src/cli.ts`
- [ ] T024 [US4] Write failing checks first in `hooks/register.test.ts`, `tests/route-hint.test.sh` and a new `tests/adapter-gentle-shell.test.ts` (stub `gentle-shell` on PATH): each adapter delivers the output of `guidance`; each falls back to `routing.general` when the guidance command fails or prints nothing; a `role` rule in `route-hint` produces a directive calling `ask-agent-ts -r ROLE`; a `role` rule injects `SKIP DELEGATION` only when every agent of that role is in cooldown; an existing `agent` rule is unchanged
- [ ] T025 [US4] Switch `hooks/register.ts` to deliver the output of `bin/ask-agent-ts guidance`, called by its path under the plugin root and never through `ask-agent` on PATH, plus the readiness line; fall back to reading `routing.general` when that call fails or is empty
- [ ] T026 [US4] Make `bin/route-hint` use `bin/ask-agent-ts guidance` (by path next to itself) for its no-match text with the same fall back to `routing.general`, and accept `role` in a rule with the cooldown rule tested in T024, keeping `agent` rules working
- [ ] T027 [US4] Create `adapters/gentle-shell/orchestrate`: starts `gentle-shell -- --append-system-prompt "$(bin/ask-agent-ts guidance)" "$@"` resolving the router by path, and nothing else
- [ ] T028 [US4] Add an example `claude` agent entry and an `orchestrator` key to `agents.json`, and document both adapters and the `orchestrator` key in `README.md`

**Checkpoint**: the router no longer assumes Claude Code.

## Phase 7: User Story 5 - Private policy file (P3)

**Goal**: site-specific text loads from outside the repository; the router works without it.

**Independent test**: same task with and without the private file; the preamble arrives only with it.

- [ ] T029 [US5] Write failing tests in `tests/policy.test.ts`: a `policy.json` under `$XDG_CONFIG_HOME/multi-agent-router/` adds a `prompt_preamble` that reaches the stub; `ASK_AGENT_POLICY` overrides the path; a missing file is no error; objects merge key by key while scalars and arrays from the private file replace; invalid JSON or a failing rule exits 2 naming the file path and key
- [ ] T030 [US5] Implement the private policy merge in `src/config.ts`, validating the merged result
- [ ] T031 [US5] Add `tests/fixtures/policy.example.json` as a neutral example and document the private policy file in `README.md`. Do NOT remove anything from `agents.json` here: the bash router in daily use does not read the private file (see T039)

**Checkpoint**: the private file works; the repository config is still complete for the bash router.

## Phase 8: Port the remaining commands and finish

- [ ] T032 Port `status`, `reset` and `runs` to `src/cli.ts` and `src/state.ts`, removing their hand-off; parity suite stays green
- [ ] T033 Port `parallel` to `src/run.ts` and `src/cli.ts` (every ready agent at once, `### agent` blocks on stdout, each agent's stderr replayed); parity suite stays green
- [ ] T034 Port `--backend hc` to `src/run.ts` with the precedence flag, `agents.<id>.backend`, `backend`, `subprocess`, and the fall back to subprocess when `hc` cannot start; the 11 hc checks of the parity suite stay green
- [ ] T035 Run every step of `specs/001-role-based-routing/quickstart.md` sections 1 to 3 and record the results, including two timings: router overhead before the agent starts (target under 300 ms) and the `roles` listing (target under 10 s)
- [ ] T036 Update `skills/delegate/SKILL.md` and `agents/*.md` to call by role where a role exists
- [ ] T037 Quickstart section 4 on the user's machine, then move `~/.local/bin/ask-agent` to `bin/ask-agent-ts` only on the user's explicit go-ahead; `bin/ask-agent` stays in the repository
- [ ] T038 Create the user's real `policy.json` outside the repository with the client-specific `prompt_preamble` texts and routing prose copied verbatim from `agents.json`, and confirm with `ask-agent-ts` and a `stub-argv` copy of the config that each agent receives the same preamble as before
- [ ] T039 [US5] Only after T037 and T038: replace the client-specific text in `agents.json` with generic versions. From this point the bash fallback runs with generic preambles; state that in `README.md`

## Dependencies

- Phase 1, then Phase 2; Phase 2 blocks every story.
- US1 then US2 (fallback extends the role run).
- US3 needs US1. US4 needs US1 and US3 (`routing.rules[].role` validation). US5 needs Phase 2 only.
- Phase 8 needs Phase 2; T037 needs everything before it; T038 then T039 come last.
- Until T037, adapters reach the new router only by path and fall back to `routing.general`; `ask-agent` on PATH stays the bash router.

## Parallel opportunities

- T002 and T003 touch different files.
- After US2, US3 and US5 are independent of each other (US5 touches `src/config.ts` merge code, US3 its validation code: same file, so run one after the other if a single person works).
- T032, T033 and T034 share `src/cli.ts` and `src/run.ts`: sequential.

## Implementation strategy

- **MVP**: Phases 1 to 4. Roles with fallback, called by hand through `bin/ask-agent-ts`, while the bash router keeps serving daily use.
- Then US3 (safety), US4 (orchestrator), US5 (private policy), then Phase 8.
- Each phase ends with both suites green and is its own commit.
