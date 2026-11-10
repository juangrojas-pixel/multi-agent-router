<!--
Sync Impact Report
Version change: (template) -> 1.0.0
Modified principles: none (initial ratification)
Added sections: Core Principles I-VII, Scope and Constraints, Development Workflow, Governance
Removed sections: none
Follow-up TODOs: none
-->

# multi-agent-router Constitution

## Core Principles

### I. Official CLIs Only

Every agent MUST run through its vendor's own CLI, using the login the user already has in
that CLI. The router MUST NOT read, extract, copy, or reuse an agent's credentials or session
tokens, and MUST NOT call a vendor API while presenting itself as that vendor's client.

Rationale: the router's value is coordination. Launching the official CLI keeps each
subscription inside the use its vendor supports.

### II. Declarative Config Is the Single Source of Truth

Roles, agents, models, effort levels, fallbacks, quota thresholds, and timeouts MUST live in
the config file. Which agent takes which role MUST be decided by config, never by prose
injected into a prompt and never by a constant in code. Roles are user-defined; the router
ships examples and MUST NOT hardcode a fixed role list.

Rationale: a role assignment that lives in prose cannot be validated, listed, or changed
without rewriting instructions.

### III. Host-Agnostic Core

The core MUST NOT depend on Claude Code or on any single orchestrating agent. Any agent
declared in config can hold the orchestrator role. Host integration (plugin, hook, extension)
MUST be a thin adapter that calls the core through its public CLI and adds no routing logic.

Rationale: the orchestrator is a role, not a product.

### IV. Private Policy Stays Out of the Repository

Site-specific policy MUST load from a private file outside the repository: client guards,
confirmation protocols, client names, and site-specific prompt preambles. The repository
MUST contain only generic defaults and examples. The router MUST work with no private file
present.

Rationale: the repository is meant to be publishable later without a scrubbing pass.

### V. Behavior Parity Before Replacement

The existing bash `ask-agent` stays available as the fallback until the new implementation
passes the same contract tests for the commands it replaces. A replaced command MUST keep its
flags, exit codes, and output unless a spec states the change. The old path is degraded to a
fallback, not deleted, until the user decides to remove it.

Rationale: the current router works every day; a rewrite MUST NOT cost a working tool.

### VI. Test-First Through the Public Interface (NON-NEGOTIABLE)

Every behavior change starts with a failing test that exercises the public CLI, then the
implementation, then refactoring with tests green. Tests MUST assert every observable effect
of the rule under test: output, exit code, and persisted state. Tests MUST NOT call real
agent CLIs; agents are replaced by stubs declared through config.

Rationale: the router's contract is its command line, and real agents are slow, metered, and
non-deterministic.

### VII. Fail Loudly, Fall Back by Config

Invalid config MUST stop the run with a message that names the offending key, before any
agent starts. An agent that is out of quota, times out, or errors MUST fall back in the order
config declares, and every attempt MUST be recorded in the run history. The router MUST NOT
silently substitute an agent that config did not name as a fallback.

Rationale: a wrong agent doing the work quietly is worse than a clear failure.

## Scope and Constraints

- Personal use comes first. The router is built for and proven in one user's daily work
  before any publication.
- Explicitly deferred, and out of scope until a spec brings them in: open-source release,
  API-key backends, Agent Client Protocol (ACP) transport, and a review of vendor
  subscription terms. That review MUST happen before publication.
- Roles that another tool owns and launches itself cannot be routed and MUST NOT be claimed
  as routable.
- The router never pushes, publishes, or connects to remote servers on its own; agents act
  only inside the working directory and limits their role and private policy grant.

## Development Workflow

- New features and design changes are specified with Spec Kit (specify, clarify when needed,
  plan, tasks, analyze) and built with Organic Driven Development. Small, already-clear fixes
  go straight to implementation.
- Every added or changed command, option, or message updates the help text and README in the
  same change.
- Run history and routing logs MUST NOT record secrets; prompt text is truncated as the
  current implementation does.

## Governance

This constitution supersedes other practices in this repository. A spec or plan that
conflicts with a principle MUST either change or record a justified exception in its
Complexity Tracking. Amendments are made by editing this file with a version bump and a dated
entry: MAJOR for removing or redefining a principle, MINOR for adding a principle or section,
PATCH for clarifications. Compliance is checked during plan (Constitution Check) and analyze.

**Version**: 1.0.0 | **Ratified**: 2026-11-10 | **Last Amended**: 2026-11-10
