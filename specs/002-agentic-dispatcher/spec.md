# Feature Specification: Agentic Dispatcher

**Feature Branch**: `feat/router`
**Created**: 2026-11-25
**Status**: Draft
**Input**: User description (verbatim fragments): "quiero que si sea la aplicacion que controle todos mis agentes", "que claude pueda decir pues mira para esta tarea mando a agy en neon por que es lo suficioente capaz de hacerla, depues otra tarea se la manda a gentle-shell con sol 6.2 ymientras tanto voy documentando con opencode", "antes de iniciar algo verificar quue todo este actualizaod, que cada quien pueda elegir su modelo", "que haya una ofrma de consultar siempre los modelos que tenemos disponibles y podemos utilizar , por que a veces hay modelos que salen pero no podemos utilizar", "que valida costo valor si hago una tarea que me va a gastar mucho mejor la hago con otro", "que claude pueda decidir si es mejor mandar varios agentes, hacer un ajambre de agentes", "https://artificialanalysis.ai/ esa u n pagina de ejemplo pero hay mas donde puede consultar".

## Context

Today the router fixes one model per role. The orchestrator cannot see which models each
account can really use, how capable each model is, or what a task will cost. One executor
(gentle-shell) has no default model in config, so unless a model is requested it runs whatever
its own settings name (an older model), and nothing records which model actually ran. The
Claude executor is disabled. Parallel
runs send the same prompt to every agent instead of distinct tasks to distinct agents.

This feature turns the router into the control point for every agent: the orchestrator plans
the work, and for each task picks an agent and a model with evidence the router supplies.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Know which models we can really use (Priority: P1)

The orchestrator (or the user) asks the router which models are usable right now, per agent.
The answer lists only models the account can run today, separate from models that exist but
are not available to this account, with each model's capability tier and current quota.

**Why this priority**: every other decision (who does what, at what cost) depends on knowing
the real menu. Choosing a model the account cannot run wastes a run and the user's time.

**Independent Test**: with stub agents declared in config, one reporting models A and B as
usable and model C as unavailable, the catalog lists A and B as usable and C as unavailable,
and exits 0.

**Acceptance Scenarios**:

1. **Given** each enabled agent can report its models through its own CLI, **When** the
   catalog is requested, **Then** each agent shows its usable models, their capability tier,
   and quota left.
2. **Given** a model was released but the account cannot use it, **When** the catalog is
   requested, **Then** that model appears as unavailable with the reason, never as usable.
3. **Given** an agent cannot report its models, **When** the catalog is requested, **Then**
   that agent shows the models declared in config, marked as unverified, and the catalog
   still answers for the other agents.

---

### User Story 2 - Every agent runs the model it is asked for (Priority: P1)

When a task is sent to an agent with a specific model, that agent runs that model, or the run
fails loudly. This includes gentle-shell and Claude as an executor.

**Why this priority**: per-task model choice is meaningless if an executor silently runs a
different model.

**Independent Test**: send a task to a stub agent with model X; the run history records
model X as requested and used. Send a model the agent does not offer; the run exits non-zero
naming the model and agent, and no agent starts.

**Acceptance Scenarios**:

1. **Given** gentle-shell offers model "sol", **When** a task is sent to gentle-shell with
   that model, **Then** gentle-shell runs that model and the run history records it.
2. **Given** the Claude executor is enabled in config, **When** a task is sent to it with a
   model, **Then** it runs with that model.
3. **Given** a requested model is not in the agent's usable list, **When** the task is sent,
   **Then** the run stops before starting the agent, naming the agent and the model.

---

### User Story 3 - Preflight before starting work (Priority: P1)

Before a plan starts, one command checks that everything is up to date: agent CLI versions
against their latest release, quotas, model availability, and how fresh the capability data
is. It reports what is outdated and how to update it.

**Why this priority**: the user asked that nothing starts on stale tools or a stale model list.

**Independent Test**: with a stub agent whose installed version is older than its reported
latest, preflight lists that agent as outdated with its update command and exits with the
"outdated" status.

**Acceptance Scenarios**:

1. **Given** every agent is current, quotas are above threshold and capability data is fresh,
   **When** preflight runs, **Then** it reports ready and exits 0.
2. **Given** one agent CLI is outdated, **When** preflight runs, **Then** it names the agent,
   installed and latest versions, and the update command, and exits with a distinct non-zero
   status.
3. **Given** preflight finds something outdated, **When** it reports, **Then** it changes
   nothing: it never updates a CLI on its own.

---

### User Story 4 - Choose agent and model per task with cost/value (Priority: P2)

For a planned task, the orchestrator states what the task needs (difficulty, kind of work,
expected size). The router answers with ranked candidates (agent and model) that are capable
enough, with each one's estimated cost and the reason. The orchestrator picks one, and the
choice and its reason are recorded with the task.

**Why this priority**: this is the core of "send agy on neon because it is capable enough":
the cheapest option that is good enough, unless the task justifies more.

**Independent Test**: with a catalog of stub models at known tiers and costs, a task that
needs tier "standard" returns the cheapest usable model at tier standard or above first; a
model below tier standard is never returned.

**Acceptance Scenarios**:

1. **Given** two usable models meet the needed tier, **When** candidates are requested,
   **Then** the cheaper one ranks first and each candidate shows cost and reason.
2. **Given** the estimated cost of the best candidate exceeds the configured cost ceiling,
   **When** candidates are requested, **Then** the router flags it and proposes the cheapest
   capable alternative.
3. **Given** the orchestrator dispatches a task with a chosen agent and model, **When** the
   run finishes, **Then** the run history records the task, agent, model, reason, and outcome.

---

### User Story 5 - Swarm: distinct tasks to distinct agents in parallel (Priority: P2)

The orchestrator dispatches several distinct tasks at once, each to its own agent and model
(for example code to one agent while another writes documentation). Each task returns its own
receipt. The orchestrator can also decide that one task goes to several agents for
independent opinions.

**Why this priority**: "mientras tanto voy documentando con opencode" requires distinct work
running at the same time, not one prompt copied to every agent.

**Independent Test**: dispatch three tasks to three stub agents with distinct prompts; three
receipts come back, each tied to its task, and the run history holds three entries.

**Acceptance Scenarios**:

1. **Given** a batch of tasks, each with agent, model and working directory, **When** the
   batch is dispatched, **Then** they run concurrently up to the configured limit, and each
   returns a receipt tied to its task ID.
2. **Given** one task in the batch fails, **When** the batch finishes, **Then** the other
   receipts are still returned, and the failed task follows its configured fallback.
3. **Given** two tasks in a batch declare overlapping write directories, **When** the batch
   is submitted, **Then** the router rejects it before starting any agent, naming the overlap.

---

### User Story 6 - Capability knowledge from external benchmarks (Priority: P3)

The router keeps a capability profile per model (quality per kind of work, speed, price
indicator) built from public benchmark sites such as artificialanalysis.ai and others, mapped
to the model names each agent uses. The profile is cached locally and refreshed on demand or
when preflight finds it stale.

**Why this priority**: tiers can start hand-declared in config (P1/P2 work without this);
external data makes the choice evidence-based and keeps up with new models.

**Independent Test**: refresh from a stub benchmark source with known scores; the catalog
shows those scores for the mapped models, the source and the date.

**Acceptance Scenarios**:

1. **Given** a benchmark source lists a model the account uses, **When** the profile is
   refreshed, **Then** the catalog shows its scores with source and date.
2. **Given** a benchmark source is unreachable, **When** refreshed, **Then** the previous
   cached profile stays in use and is reported as stale with its date.
3. **Given** a usable model has no benchmark data, **When** shown in the catalog, **Then**
   its tier comes from config and is marked as declared, not measured.

### User Story 7 - See every delegated agent in Herdr (Priority: P2)

When the orchestrator runs inside a Herdr pane and sends a task to another agent, that agent
runs in a sibling Herdr pane that shows its live output and appears in Herdr's sidebar with its
name, model and state (working, then done or failed). User words: "quiero poder tambien ver al
lado izquierdo cuando claude manda otro agente".

**Why this priority**: the user watches the swarm work; hidden subprocesses give no feedback.

**Independent Test**: with a stub `herdr` binary that records its calls, a run with the herdr
backend splits a pane, labels it, reports the agent working, runs the agent in it, reports it
done, and returns the same stdout and exit code as the subprocess backend.

**Acceptance Scenarios**:

1. **Given** the router runs inside Herdr (`HERDR_ENV=1`) with backend `herdr`, **When** a task
   runs, **Then** a sibling pane opens without taking focus, is labeled `<agent> <task or model>`,
   and the agent is reported `working` to Herdr until the run ends.
2. **Given** the run ends, **Then** the answer, stderr, exit code, quota detection and timeout
   behave exactly as with the subprocess backend; the pane closes after success and stays open
   after a failure so the user can read it.
3. **Given** the router is not inside Herdr or Herdr refuses the split, **When** a task runs,
   **Then** it falls back to the subprocess backend and logs why.

### User Story 8 - Watch and steer each agent live in the Herdr app (Priority: P2)

With the live backend, a delegated agent runs in its own interactive TUI inside an hc terminal
under the orchestrator, so the Herdr app shows it with its icon and live status (working, done,
blocked) and the user can open it, watch every step and even type to it. User words: "el modelo
interactivo me gustaria para ver que esta haciendo cada agente por que esa es como el razon ser".

**Why this priority**: seeing each agent work is the reason the user wants the swarm in Herdr.

**Independent Test**: with a stub hc that plays an interactive agent (statuses blocked/idle/done,
writes the answer file when the task arrives), a live run starts the TUI by absolute path,
answers only the configured startup dialogs, sends the task, waits for done and returns the
answer from the answer file with exit 0.

**Acceptance Scenarios**:

1. **Given** backend `live` and an agent with a `live` config, **When** a task runs, **Then** the
   agent's TUI starts by absolute path in an hc terminal under the caller, with the requested
   model, and the task is sent once the agent reports idle.
2. **Given** the agent stops at a startup dialog listed in its config (for example "Trust this
   folder?" for the task's own directory), **Then** the router answers it with the configured
   keys; **Given** any other blocked state, **Then** the run stops with exit 2 naming the dialog,
   and the terminal stays open for the user.
3. **Given** the agent reports done, **Then** the answer is the content of the answer file the
   task asked for, the run records the requested model (`model_source: requested`), and the
   terminal stays open for the user to read or continue.
4. **Given** an agent without a `live` config (opencode today: its TUI has no model flag), **When**
   backend `live` is selected, **Then** that agent runs with the hc backend instead and says so.

### Edge Cases

- An agent's quota runs out mid-swarm: that task falls back by config; the others continue.
- A model name differs between the agent CLI and the benchmark site: the mapping comes from
  config; unmapped models show "no benchmark data", never a guessed match.
- The orchestrator asks for a model the agent offers but the quota for that model family is
  exhausted (agy separates Gemini quota from Claude/GPT quota): the model shows as usable but
  out of quota, and candidates skip it.
- Preflight runs offline: version and benchmark checks report "unknown", not "current".
- The Claude executor and the orchestrator share one subscription quota: candidates show that
  shared cost explicitly.
- A swarm larger than the concurrency limit: excess tasks queue in order, never dropped.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The router MUST list, per enabled agent, the models usable right now, obtained
  through that agent's own CLI where it can report them.
- **FR-002**: The router MUST distinguish usable, unavailable (with reason), out-of-quota and
  unverified models.
- **FR-003**: Every executor, including gentle-shell and the Claude executor, MUST accept a
  requested model and run it, or stop before starting naming agent and model.
- **FR-004**: The router MUST record, per run, the requested model, the model used, the task
  ID when given, and the reason for the choice when given.
- **FR-005**: A preflight command MUST report, per agent, installed vs latest CLI version,
  quota left, model availability, and capability-data freshness, with a distinct exit status
  for ready, outdated, and failed.
- **FR-006**: Preflight MUST NOT update, install or reconfigure anything; it reports the
  update command for each outdated item.
- **FR-007**: Given task needs (minimum tier, kind of work, expected size), the router MUST
  return ranked candidate agent/model pairs that meet the tier, cheapest capable first, each
  with estimated cost and reason.
- **FR-008**: The router MUST flag a candidate whose estimated cost exceeds a configured
  ceiling and propose the cheapest capable alternative.
- **FR-009**: The router MUST dispatch a batch of distinct tasks, each with its own agent,
  model, prompt and working directory, concurrently up to a configured limit, returning one
  receipt per task.
- **FR-010**: The router MUST reject a batch whose tasks declare overlapping write
  directories, before any agent starts.
- **FR-011**: A failed task in a batch MUST follow its configured fallback without stopping
  the other tasks; every attempt MUST be recorded.
- **FR-012**: The router MUST keep a cached capability profile per model from one or more
  public benchmark sources, with source and date per value, and a config mapping between
  benchmark model names and agent model names.
- **FR-013**: When no benchmark data exists for a model, its tier MUST come from config and be
  marked as declared.
- **FR-014**: Roles in config MUST remain the default route when the orchestrator does not
  choose an agent and model explicitly.
- **FR-015**: All capability tiers, cost ceilings, concurrency limits, benchmark sources and name
  mappings MUST live in config, validated before any agent starts.
- **FR-016**: The orchestrator guidance (`ask-agent guidance`) MUST explain how to use the
  catalog, candidates, preflight and batch dispatch, so any orchestrator can follow it.
- **FR-017**: Help text and README MUST document every new command and option.
- **FR-019**: With backend `herdr` inside a Herdr pane, each agent run MUST open a sibling pane
  (no focus change), label it, report the agent state to Herdr (working, then idle or released),
  and return the same result as the subprocess backend; outside Herdr it MUST fall back to the
  subprocess backend and say so.
- **FR-020**: With backend `live`, an agent that declares a `live` config MUST run as an
  interactive TUI in an hc terminal under the caller: started by absolute path, startup dialogs
  answered only when they match the agent's configured list, task sent when idle, answer read
  from the answer file the task names; any other blocked state stops the run (exit 2) and leaves
  the terminal open; agents without `live` fall back to the hc backend.
- **FR-018**: A batch task marked as client work MUST run only on agents the private policy
  allows for client work; a batch naming any other agent for such a task MUST be rejected
  before any agent starts, and candidates for client work MUST list only allowed agents.

### Key Entities

- **Agent**: an executor CLI declared in config; has models, quota, version, fallback order.
- **Model**: a model an agent can run; has availability status, capability tier, quota
  family, cost indicator, optional benchmark profile.
- **Capability Profile**: per-model scores by kind of work, speed and price, with source and
  date; cached locally.
- **Task Need**: what a task requires: minimum tier, kind of work, expected size.
- **Candidate**: an agent/model pair that meets a task need, with estimated cost and reason.
- **Dispatch Batch**: a set of tasks, each with ID, agent, model, prompt and write directory.
- **Receipt**: the result of one task: files written, commands run, outcome.
- **Preflight Report**: per-agent version, quota, model and data-freshness status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of runs record the model actually used; zero runs execute a model other
  than the one requested without failing loudly.
- **SC-002**: The catalog answers for all enabled agents in under 30 seconds, and never lists
  as usable a model the account cannot run.
- **SC-003**: Preflight detects 100% of agents whose installed version is behind the latest
  reported release, in under 60 seconds.
- **SC-004**: For a task need, the first candidate is the cheapest model that meets the tier
  in 100% of test cases.
- **SC-005**: A batch of 3 distinct tasks completes in no more than the slowest single task
  plus 10% overhead, returning 3 receipts.
- **SC-006**: Over two weeks of daily use, the share of delegated tasks routed to a model
  cheaper than the role default, without a failed or redone outcome, is reported in run
  history.

## Assumptions

- "Cost" means subscription quota consumed and relative price indicator, not billed money:
  every agent runs on a flat subscription through its official CLI (Constitution I). The
  benchmark price per token serves as a relative indicator only.
- The orchestrator makes the final choice; the router supplies evidence and records it. This
  keeps roles as the config default (Constitution II) and lets any orchestrator use it
  (Constitution III).
- Model discovery uses each vendor's CLI. Agents that cannot list their models fall back to
  the models declared in config, marked unverified.
- Benchmark sites are public pages read on demand; no vendor API is called as a vendor client.
- Preflight only reports; updating CLIs stays a user decision (it changes the environment).
- Concurrency limit default: 3 agents at once, configurable.
- The Claude executor is enabled as an option; its quota is shared with the orchestrator and
  candidates show that.
- Client-environment guards stay as today: client servers/OCI/DBs only through Claude or
  gentle-shell; the dispatcher never routes such tasks to other agents.
