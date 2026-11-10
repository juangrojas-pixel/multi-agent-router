# CLI Contract: ask-agent

The command line is the public interface. Everything under "Existing" must behave exactly as
the bash router does today; `tests/ask-agent.test.sh` is the check.

## Existing (unchanged)

```text
ask-agent [-t TIER | -a A[,B]] [-m MODEL] [-C DIR] [--backend hc|subprocess] [PROMPT]
ask-agent parallel [same flags] [PROMPT]
ask-agent status
ask-agent reset [AGENT]
ask-agent runs [N] [-a AGENT]
ask-agent -h | --help
```

- Long forms: `--tier`, `--agent`, `--model`, `--cwd`. `--` ends option parsing.
- The prompt is the remaining arguments, or stdin when there are none.
- stdout: the answer; `### agent` blocks for `parallel`; the `status` table; the `runs` TSV.
- stderr: everything else, prefixed `[ask-agent]`.
- Exit status: `0` success; `2` any failure (bad usage, config missing, nested call, no
  candidate ready, every candidate failed).
- Environment: `ASK_AGENT_CONFIG` (config path), `XDG_CACHE_HOME` (state directory),
  `ASK_AGENT_DEPTH` (set by the router on delegates; a call with it set is refused).

## New

### Run by role

```text
ask-agent -r ROLE [-C DIR] [--backend hc|subprocess] [PROMPT]
ask-agent --role ROLE ...
```

- Resolves ROLE as described in `data-model.md` and prints the answer on stdout.
- `-r` together with `-a` or `-t`: exit 2, `[ask-agent] use only one of -r, -a, -t`.
- `-r` together with `-m`: exit 2; the model comes from the role.
- Unknown role: exit 2, `[ask-agent] unknown role: NAME (configured: a, b, c)`.
- No roles configured: exit 2, `[ask-agent] no roles configured`.
- Every entry unavailable or failed: exit 2, one stderr line per entry with its reason, then
  `[ask-agent] role NAME: no agent could run`.
- Each fallback step prints `[ask-agent] role NAME: AGENT failed (REASON), trying NEXT` on
  stderr.

### List roles

```text
ask-agent roles
```

- stdout, one line per role entry, tab-separated: `role  agent  model  effort  ready  reason`.
  `model` and `effort` show `-` when unset. `ready` is `yes` or `no`; `reason` is empty when
  ready (otherwise `disabled`, `not installed`, or `cooldown until HH:MM`).
- A first line `orchestrator  AGENT` when `orchestrator` is configured.
- Exit 0, including when some entries are not ready.

### Orchestrator guidance

```text
ask-agent guidance
```

- stdout: the routing guidance text generated from the roles: one line per role with its
  description and the exact call form (`ask-agent -r NAME -C <dir> "<task>"`), followed by
  `routing.notes` when set. The text names no orchestrating product.
- No roles configured: prints only `routing.notes` (or nothing). Exit 0.

### Validation (applies to every command)

- The merged config is validated first. On the first failing rule: exit 2 and
  `[ask-agent] config: KEY: MESSAGE` on stderr, naming the key as listed in `data-model.md`;
  no agent is started.
- Private policy path: `${XDG_CONFIG_HOME:-~/.config}/multi-agent-router/policy.json`, or
  `ASK_AGENT_POLICY`. Missing file: no error. Problems inside it are reported with the file
  path in the message.

## Adapters (not part of the router's CLI)

- Claude Code: `hooks/register.ts` delivers the output of `ask-agent guidance` plus the
  readiness line. `bin/route-hint` uses the same output when no rule matches.
- gentle-shell: `adapters/gentle-shell/orchestrate` starts
  `gentle-shell -- --append-system-prompt <guidance> "$@"`.
- Until the user moves `ask-agent` on PATH to the new entry, adapters call
  `bin/ask-agent-ts` by path and fall back to `routing.general` when it fails or is empty.
- A `role` rule in `route-hint` injects `SKIP DELEGATION` only when every agent of the role
  is in cooldown.
- An adapter contains no rule, role or agent name of its own.
