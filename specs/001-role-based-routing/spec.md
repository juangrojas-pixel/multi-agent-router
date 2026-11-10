# Feature Specification: Role-Based Agent Routing

**Feature Branch**: `feat/router` (spec directory `001-role-based-routing`)
**Created**: 2026-11-10
**Status**: Draft
**Input**: User description: "Declare in config what each agent is in charge of, for example: claude orchestrates; agy and gentle-shell write code; codex gives a read-only second opinion. The router must adapt to any agent instead of being tied to one orchestrator."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a task by role (Priority: P1)

The user declares named roles in the config file, each one saying which agent is in charge.
From then on, the orchestrating agent (or the user at a terminal) asks the router to run a
task "as the coder role" instead of naming an agent or a tier. The router resolves the role
to its agent and runs the task there.

**Why this priority**: this is the core of the request. Today "who does what" lives in a
prose policy; without this story nothing else in the feature has a purpose.

**Independent Test**: declare one role pointing at a stub agent, run a task by that role, and
confirm the stub agent received the task and its answer came back.

**Acceptance Scenarios**:

1. **Given** a role `coder` assigned to agent `agy`, **When** the user runs a task by role
   `coder`, **Then** the task runs on `agy` and the answer is returned.
2. **Given** a role with a model and an effort level set, **When** a task runs by that role,
   **Then** the agent is started with that model and that effort level.
3. **Given** a role with only an agent set, **When** a task runs by that role, **Then** the
   agent's own default model and effort apply.
4. **Given** a role name that is not in the config, **When** the user runs a task by it,
   **Then** the run stops with a message naming the unknown role and listing the configured
   ones, and no agent starts.
5. **Given** existing calls that name an agent or a tier, **When** they run after this
   feature ships, **Then** they behave exactly as before.

---

### User Story 2 - Fall back when the assigned agent cannot work (Priority: P1)

A role lists more than one agent in order. When the first one is out of quota, in cooldown,
times out, or fails, the router moves to the next one without the user stepping in, and the
run history shows what happened.

**Why this priority**: the user works on subscription quotas that run out mid-day. A role
that stops working when one agent is exhausted is not usable daily.

**Independent Test**: declare a role with two stub agents, make the first report it is out
of quota, run a task by the role, and confirm the second handled it and both attempts are in
the history.

**Acceptance Scenarios**:

1. **Given** role `coder` with agents `gentle-shell` then `agy`, **When** `gentle-shell` is
   in cooldown, **Then** the task runs on `agy`.
2. **Given** the same role, **When** `gentle-shell` fails with a quota error mid-run,
   **Then** it enters cooldown and the task is retried on `agy`.
3. **Given** every agent of the role is unavailable, **When** a task runs by that role,
   **Then** the run stops with a message naming the role and why each agent was skipped.
4. **Given** a fallback happened, **When** the user reads the run history, **Then** each
   attempt appears with its role, agent, and outcome.

---

### User Story 3 - See what each role resolves to and catch mistakes (Priority: P2)

The user lists the configured roles and sees, for each, the agent, model, effort level, and
whether that agent is ready right now. A mistake in the config is reported clearly and
early, naming the exact entry at fault.

**Why this priority**: roles are edited by hand. Without a listing and loud validation, a
typo turns into a run that quietly goes to the wrong agent.

**Independent Test**: write a config with one valid role and one role pointing at an agent
that does not exist; confirm the listing shows the valid one and the error names the bad one.

**Acceptance Scenarios**:

1. **Given** three configured roles, **When** the user lists roles, **Then** each role shows
   its agents in order, model, effort, and readiness.
2. **Given** a role that names an agent missing from the config, **When** any command runs,
   **Then** it stops before starting any agent with a message naming the role and the agent.
3. **Given** a role that sets a model the agent does not offer, or an effort level on an
   agent that has none, **When** any command runs, **Then** it stops with a message naming
   the role and the offending setting.
4. **Given** a role assigned to a disabled agent, **When** the user lists roles, **Then**
   that agent is shown as not ready with the reason.

---

### User Story 4 - Any agent can be the orchestrator (Priority: P2)

The orchestrator is a role like the others. The config says which agent holds it, and the
routing guidance that agent receives is generated from the configured roles instead of being
written by hand as prose.

**Why this priority**: it is what makes the router "adapt to any agent". It depends on
Stories 1 to 3 being in place.

**Independent Test**: change the role descriptions in config, ask the router for the
orchestrator guidance, and confirm the text reflects the new roles with no hand edit.

**Acceptance Scenarios**:

1. **Given** roles with descriptions, **When** the router produces the orchestrator
   guidance, **Then** it lists each role, what it is for, and how to call it.
2. **Given** the orchestrator role is assigned to a different agent, **When** guidance is
   produced, **Then** it is the same guidance, addressed to no specific product.
3. **Given** an agent already running as a delegate, **When** it tries to delegate again
   through the router, **Then** the call is refused, as today.
4. **Given** a second agent, different from Claude Code, holding the orchestrator role,
   **When** the user gives it a task that fits a configured role, **Then** it delegates that
   task through the router by role and the delegate's answer comes back to it.

---

### User Story 5 - Site policy lives in a private file (Priority: P3)

The user keeps client guards, the confirmation protocol, and client-specific prompt
preambles in a private file outside the repository. The router merges them when the file
exists and works normally when it does not.

**Why this priority**: it keeps the repository free of site-specific content, which matters
for a later release, but it does not change daily behavior for the user today.

**Independent Test**: run the same role-based task with and without the private file;
confirm the private preamble reaches the agent only when the file is present.

**Acceptance Scenarios**:

1. **Given** a private file that adds a preamble to an agent, **When** a task runs on that
   agent, **Then** the agent receives the preamble.
2. **Given** no private file, **When** any command runs, **Then** it works with the generic
   defaults and reports no error.
3. **Given** a private file with an invalid entry, **When** any command runs, **Then** it
   stops with a message naming the private file and the entry.

### Edge Cases

- A role lists the same agent twice: it is tried once.
- A role's fallback agent is the agent currently orchestrating: allowed only if the
  orchestrator can also work as a delegate; otherwise it is reported as not ready.
- A role and a tier share a name: they are separate namespaces and the user states which one
  is meant by how the task is requested.
- The config has no roles at all: role-based requests stop with a clear message; agent and
  tier requests are unaffected.
- A task is requested with both a role and an explicit agent: the request is rejected as
  ambiguous.
- The private file and the repository config define the same agent setting: the private file
  wins.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Users MUST be able to define any number of named roles in the config file;
  the system MUST NOT require or assume a fixed list of role names.
- **FR-002**: Each role MUST name one or more agents in priority order and MAY set a
  description, a model, and an effort level.
- **FR-003**: Users MUST be able to run a task by role name.
- **FR-004**: The system MUST resolve a role to the first agent in its list that is ready,
  and apply the role's model and effort to it when set.
- **FR-005**: When the chosen agent runs out of quota, times out, or fails, the system MUST
  continue with the next agent of the role, applying the same cooldown rules used today.
- **FR-006**: The system MUST record every attempt of a role-based run in the run history,
  including the role name.
- **FR-007**: The system MUST validate the whole config before starting any agent and MUST
  stop with a message naming the offending role and setting when: a role names an unknown
  agent, sets a model the agent does not offer, or sets an effort level on an agent that
  does not support one.
- **FR-008**: Users MUST be able to list the configured roles with, for each, its agents,
  model, effort, and current readiness with the reason when not ready.
- **FR-009**: Existing requests by agent name and by tier MUST keep their current behavior,
  options, output, and exit status.
- **FR-010**: The config MUST allow declaring which agent holds the orchestrator role.
- **FR-011**: The system MUST produce the routing guidance for the orchestrator from the
  configured roles and their descriptions; that guidance MUST NOT name a specific
  orchestrating product.
- **FR-012**: This feature MUST deliver two working orchestrator integrations: the existing
  Claude Code one and one for a second, different agent. Both MUST receive the same generated
  guidance and reach the router the same way, and each MUST contain no routing logic of its
  own. Which second agent is used is decided during planning from what each agent allows.
- **FR-013**: The system MUST load an optional private policy file from outside the
  repository, merge it over the repository config, and work without it.
- **FR-014**: The repository MUST contain only generic defaults and example roles; client
  names, client guards, and confirmation protocols MUST come from the private file.
- **FR-015**: The system MUST keep refusing nested delegation.
- **FR-016**: The current router MUST remain usable as the fallback until the new behavior
  matches it on every command it replaces.

### Key Entities

- **Role**: a named responsibility defined by the user. Has a description, an ordered list
  of agents, and optionally a model and an effort level.
- **Agent**: a command-line agent the router can start. Declares how it is started, which
  models it offers, whether it supports effort levels, its limits, and whether it is enabled.
- **Orchestrator assignment**: which agent currently holds the orchestrating role.
- **Private policy**: optional site-specific additions that override or extend agents and
  roles; never stored in the repository.
- **Run record**: one attempt of a task, with role, agent, model, outcome, and duration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The user changes which agent handles a role by editing one entry, and the next
  task by that role runs on the new agent with no other change.
- **SC-002**: 100% of config mistakes covered by FR-007 are reported before any agent
  starts, each with the role and setting at fault.
- **SC-003**: When the first agent of a role is unavailable, the task completes on a
  fallback agent with no action from the user.
- **SC-004**: Every existing agent and tier request produces the same result as before the
  feature, checked against the existing test suite.
- **SC-005**: The user can see what every role resolves to, and whether it is ready, with
  one request and in under 10 seconds.
- **SC-006**: The repository contains zero client names, client guards, or site-specific
  preambles once the private policy file is in use.
- **SC-007**: The hand-written routing prose shrinks to what is not a role assignment; who
  handles what is stated only in config.

## Clarifications

### Session 2026-11-10

- Q: Is orchestrator support limited to generic guidance delivered through the existing
  Claude Code integration, or must a second orchestrating agent also work? → A: A second
  orchestrating agent must also work in this feature (option B).

## Assumptions

- Single user on one machine; no sharing of config between users.
- A role with several agents means "try them in this order". Choosing between agents by
  task difficulty is expressed as separate roles (for example an easy-work role and a
  hard-work role), not as logic inside one role.
- The model and effort a role may set are declared per agent in the config by the user; the
  router does not discover them from the agent.
- Roles are edited by hand in the config file. An interactive menu is out of scope.
- Roles that another tool owns and launches itself (gentle-ai review reviewers) are not
  routable and are out of scope.
- Out of scope: open-source release, API-key backends, ACP transport, vendor terms review.
- Existing quota checks, cooldowns, timeouts, and run history stay as they are and are
  reused by role-based runs.
