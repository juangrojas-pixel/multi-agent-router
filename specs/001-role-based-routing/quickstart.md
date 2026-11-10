# Quickstart: validating Role-Based Agent Routing

Prerequisites: Node 24, `jq`, and the repository checked out. No install step.
See `contracts/cli.md` for exact messages and `data-model.md` for the config shape.

## 1. Automated checks

```bash
node --test tests/                                           # new unit and CLI tests
ASK_AGENT_BIN=bin/ask-agent-ts bash tests/ask-agent.test.sh  # parity with the bash router
bash tests/ask-agent.test.sh                                 # bash router still passes
tests/route-hint.test.sh
```

Expected: every suite passes. The parity run must report the same number of passed checks as
the bash run for the commands already ported.

## 2. Roles by hand, with stub agents (no real agent is called)

Use a scratch config so nothing real runs:

```bash
export XDG_CACHE_HOME=$(mktemp -d) XDG_CONFIG_HOME=$(mktemp -d)
export ASK_AGENT_CONFIG=$XDG_CACHE_HOME/agents.json
# write a config with two stub agents (a script that echoes its last argument)
# and a role "coder" listing both; see tests/fixtures/ for a ready one
```

| Step | Command | Expected |
|---|---|---|
| Run by role | `ask-agent-ts -r coder "hello"` | answer from the first stub, exit 0 |
| List | `ask-agent-ts roles` | one line per entry, `ready yes` |
| Fallback | put the first stub in cooldown, run again | answer from the second stub; stderr shows the fallback line |
| Unknown role | `ask-agent-ts -r nope "x"` | exit 2, message lists configured roles |
| Bad config | set a role agent to `ghost` | exit 2, `config: roles.coder.agents[0]`, no agent started |
| Guidance | `ask-agent-ts guidance` | one line per role with its call form |
| History | `ask-agent-ts runs 5` | attempts listed; `runs.jsonl` lines carry `role` |

## 3. Private policy

```bash
mkdir -p "$XDG_CONFIG_HOME/multi-agent-router"
# policy.json adding a prompt_preamble to one stub agent
```

Expected: the stub receives the preamble; removing the file removes it; a broken file stops
the run naming the file.

## 4. Real use (the user's machine)

1. `ask-agent-ts roles` with the real config: every role resolves, readiness is right.
2. In Claude Code, after `/reload-plugins`: the injected guidance lists the roles.
3. `adapters/gentle-shell/orchestrate` starts gentle-shell; ask it for a task that fits a
   role and confirm it calls `ask-agent -r <role>` and gets the delegate's answer.
4. Only after 1 to 3 pass: point `~/.local/bin/ask-agent` at the new entry. The bash script
   stays in the repository as the fallback.
