# Research: Role-Based Agent Routing

Evidence comes from a read-only map of the repository and of each agent's `--help` output
(2026-11-10). Items marked UNVERIFIED were not confirmed and no decision rests on them.

## R1. Runtime and tooling

- **Decision**: TypeScript run directly by Node (24.13 installed), no build step, no runtime
  dependencies. Tests use the built-in `node:test` runner.
- **Rationale**: verified on this machine that `node file.ts` and `node --test file.test.ts`
  run TypeScript as is. No install step means nothing to break at session start. Only
  erasable TypeScript syntax is used (no enums, no parameter properties, no namespaces).
- **Alternatives considered**: Bun (not installed); a `tsc` build to `dist/` (adds a build
  step and stale-output risk for no gain); keeping bash (config validation, the role cascade
  and parallel runs get fragile at the current 513 lines).

## R2. Migration strategy

- **Decision**: a new entry point `bin/ask-agent-ts` next to the untouched bash
  `bin/ask-agent`. Until a command is ported, the new entry hands it to the bash script
  unchanged. The existing `tests/ask-agent.test.sh` runs against either one through an
  `ASK_AGENT_BIN` variable and is the parity contract. The user's `~/.local/bin/ask-agent`
  symlink moves to the new entry only when the ported commands pass it.
- **Rationale**: Constitution V. The user keeps a working router at every step.
- **Alternatives considered**: replace in place (no fallback); a long-lived parallel tool
  with its own name (two tools to keep in sync).

## R3. How an agent is started

- **Finding**: today each agent's argument shape is hard-coded by agent id in a `case`
  (`bin/ask-agent:305`), so a new agent needs a code change. The prompt is always passed as
  an argument; the agent's stdin is `/dev/null`.
- **Decision**: move the shape into config. Each agent declares an `args` template with
  `{prompt}`, `{model}`, `{effort}` and `{timeout}` placeholders, optional `model_args` and
  `effort_args` fragments that are added only when a value is set, and an `output` parser
  chosen by name: `text`, `agy-json`, `opencode-events`. The four agents known today get
  built-in defaults equal to the current hard-coded shapes, so the existing `agents.json`
  keeps working unchanged.
- **Rationale**: Constitution II and III. Parsers stay in code because they are logic, but
  which one applies is config.
- **Alternatives considered**: a fully generic output parser described in config (a query
  language for three known formats is over-engineering).

## R4. Model and effort per agent

| Agent | Model | Effort |
|---|---|---|
| pi / codex | `--model <pattern>` | `--thinking off\|minimal\|low\|medium\|high\|xhigh\|max` |
| gentle-shell | pi flags after `--` | same as pi |
| agy | `--model` | `--effort low\|medium\|high\|xhigh\|max` |
| claude | `--model` | `--effort low\|medium\|high\|xhigh\|max` |
| opencode | `run -m provider/model` | no dedicated flag (a `#variant` suffix carrying effort is UNVERIFIED) |

- **Decision**: each agent declares `effort_levels` (empty or absent means "no effort
  support") and optionally `models`. A role that sets effort on an agent without
  `effort_levels`, or a level not in the list, fails validation. When `models` is absent any
  model string is accepted for that agent; when present, the role's model must be in it.
- **Rationale**: FR-007, and the assumption that the user declares these by hand.

## R5. Second orchestrator

- **Decision**: gentle-shell (pi).
- **Rationale**: verified that pi accepts `--append-system-prompt <text|file>`, has a bash
  tool (so it can call the router), and that gentle-shell forwards pi flags after `--`. The
  adapter is a launcher that starts gentle-shell with the generated guidance appended. No pi
  extension is needed, so the adapter holds no logic.
- **Alternatives considered**: opencode. How it takes injected guidance (an `instructions`
  key, `AGENTS.md`) and whether it exposes a shell tool are UNVERIFIED from its help output;
  it can be added later as a third adapter.
- **Consequence**: an agent can be both orchestrator and delegate. Nested delegation stays
  refused through `ASK_AGENT_DEPTH`, which only the router sets on the delegate it starts.

## R6. Orchestrator guidance and the existing prompt hints

- **Finding**: `hooks/register.ts` only delivers text (it reads `routing.general` and the
  readiness line). All routing logic for Claude Code is in `bin/route-hint`, which matches
  `routing.rules` and is wired through the user's `~/.claude/settings.json`, not through the
  plugin.
- **Decision**: a new `guidance` command prints the routing guidance built from the roles
  (name, description, how to call it) followed by an optional free-text `routing.notes`.
  `register.ts`, the gentle-shell launcher and `route-hint`'s no-match case all use that
  output. `routing.rules` gain an optional `role` key next to `agent`; per-prompt rule
  matching itself stays in `route-hint` and is not ported in this feature.
- **Rationale**: FR-011, SC-007. Both adapters deliver the same text and decide nothing.

## R7. Private policy file

- **Decision**: `${XDG_CONFIG_HOME:-~/.config}/multi-agent-router/policy.json`, overridable
  with `ASK_AGENT_POLICY`. Deep-merged over the repository config: objects merge key by key,
  scalars and arrays from the private file replace. A missing file is not an error; an
  invalid one stops the run naming the file.
- **Rationale**: FR-013, FR-014, Constitution IV. Same shape as the main config, so there is
  one schema and one validator.
- **Migration**: the client-specific `prompt_preamble` texts and `routing` prose now in
  `agents.json` move to this file; the repository keeps generic versions.

## R8. Defect found in the current router

- `bin/ask-agent` calls `date -r EPOCH` (lines 77 and 208), BSD syntax that fails under GNU
  date on Linux, so cooldown times in its log line and in `status` come out empty. The new
  implementation formats times itself. The bash fallback is left as is; fixing it is a
  separate small change the user can ask for.

## R9. State files

- **Decision**: keep location and formats: `cooldown.json` (`{"agent": untilEpoch}`, written
  under a lock directory, temp file then rename), `runs.jsonl`, `last/<agent>.json`.
  `runs.jsonl` records gain one optional field, `role`.
- **Rationale**: `route-hint` reads `cooldown.json`, and both implementations must share
  state while they coexist.
