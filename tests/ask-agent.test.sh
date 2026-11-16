#!/usr/bin/env bash
# Tests for bin/ask-agent: per-agent prompt preamble (executor vs read-only advisor).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASK="${ASK_AGENT_BIN:-$ROOT/bin/ask-agent}"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
export XDG_CACHE_HOME="$SCRATCH/cache"
# Generic checks never read the user's private policy file; site checks name it explicitly.
export XDG_CONFIG_HOME="$SCRATCH/xdg"
unset ASK_AGENT_POLICY
POLICY="$HOME/.config/multi-agent-router/policy.json"

pass=0 fail=0 skipped=0
check() { # name, condition result (0 ok)
  if [[ "$2" == 0 ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi
}

# Stub agent CLI: prints the prompt it received (always the last argument),
# as an opencode JSON text event (`opencode run`) or an agy JSON result (`agy -p`).
STUB="$SCRATCH/stub"
cat >"$STUB" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == run ]]; then jq -cn --arg t "${@: -1}" '{type: "text", part: {text: $t}}'
elif [[ " $* " == *" --output-format "* ]]; then jq -cn --arg t "$2" '{status: "SUCCESS", response: $t}'
else printf '%s\n' "${@: -1}"; fi
EOF
chmod +x "$STUB"

# The real config with every agent pointed at the stub.
jq --arg s "$STUB" '.agents |= map_values(.command = $s | .extra_args = [] | del(.quota))' \
  "$ROOT/agents.json" >"$SCRATCH/agents.json"
export ASK_AGENT_CONFIG="$SCRATCH/agents.json"

ask() { "$ASK" -a "$1" "PING" 2>/dev/null; }

# Executors may write and run commands inside the working directory.
for a in gentle-shell opencode; do
  out="$(ask "$a")"
  [[ "$out" == *"executor"* && "$out" != *"read-only advisor"* ]]; check "$a gets the executor preamble" $?
  [[ "$out" == *"PING"* ]]; check "$a still receives the task" $?
done

# Site checks: only gentle-shell may work on client servers, and it stops on a guard confirmation;
# agy is read-only there. That text lives in the private policy file, which only the TypeScript
# router reads; the bash router runs with the generic preambles of agents.json.
if [[ "$(basename "$(readlink -f "$ASK")")" != ask-agent-ts ]]; then
  skipped=$((skipped + 2))
  echo "SKIP: 2 site checks (this router does not read the private policy file)"
elif [[ ! -f "$POLICY" ]]; then
  skipped=$((skipped + 2))
  echo "SKIP: 2 site checks (no private policy at $POLICY)"
else
  out="$(ASK_AGENT_POLICY="$POLICY" "$ASK" -a gentle-shell "PING" 2>/dev/null)"
  [[ "$out" == *"client servers"* && "$out" == *"CONFIRMACION REQUERIDA"* ]]; check "gentle-shell may reach clients and reports confirmations" $?
  out="$(ASK_AGENT_POLICY="$POLICY" "$ASK" -a agy "PING" 2>/dev/null)"
  [[ "$out" == *"you are read-only"* && "$out" == *"client servers"* ]]; check "agy is read-only on client servers" $?
fi
out="$(ask opencode)"
[[ "$out" == *"do not push, publish, delete data, or connect to remote servers"* ]]; check "opencode stays off remote servers" $?

# codex stays a read-only advisor (previous behavior).
out="$(ask codex)"
[[ "$out" == *"read-only advisor"* ]]; check "codex keeps the read-only preamble" $?

# opencode no longer runs the read-only plan agent.
jq -e '.agents.opencode.extra_args | index("plan") | not' "$ROOT/agents.json" >/dev/null
check "opencode does not use the plan agent" $?

# The routing policy no longer keeps writes inline.
jq -e '.routing.general | test("writes") | not' "$ROOT/agents.json" >/dev/null
check "routing does not keep writes inline" $?

# --- hc (herdr-core) backend ---------------------------------------------------
# Runs against the real hc, through a wrapper that logs every hc subcommand.
if command -v hc >/dev/null; then
  HCLOG="$SCRATCH/hc.log"
  cat >"$SCRATCH/hc-wrap" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$1" >>"$HCLOG"
exec "$(command -v hc)" "\$@"
EOF
  chmod +x "$SCRATCH/hc-wrap"
  hc_cfg() { jq --arg h "$1" '.hc_command = $h' "$SCRATCH/agents.json" >"$SCRATCH/agents-hc.json"; }
  hc_ask() { ASK_AGENT_CONFIG="$SCRATCH/agents-hc.json" "$ASK" "$@"; }

  # --backend hc returns the same answer as the subprocess backend, through hc.
  hc_cfg "$SCRATCH/hc-wrap"
  : >"$HCLOG"
  sub="$(hc_ask -a gentle-shell "PING" 2>/dev/null)"
  out="$(hc_ask --backend hc -a gentle-shell "PING" 2>"$SCRATCH/err")"; rc=$?
  [[ $rc == 0 && "$out" == "$sub" ]]; check "hc backend returns the subprocess answer" $?
  grep -qx run "$HCLOG"; check "hc backend starts the agent with hc run" $?
  grep -q 'hc attach aa-gentle-shell-' "$SCRATCH/err"; check "hc backend logs how to attach" $?
  hc ls --all --json | jq -e '[.terminals[]? | select((.name // "") | startswith("aa-"))] | length == 0' >/dev/null
  check "hc backend removes its finished terminal" $?

  # Default stays the subprocess backend.
  : >"$HCLOG"
  hc_ask -a gentle-shell "PING" >/dev/null 2>&1
  [[ ! -s "$HCLOG" ]]; check "default backend does not use hc" $?

  # agents.json backend (global or per agent) selects hc; the flag wins.
  jq '.backend = "hc"' "$SCRATCH/agents-hc.json" >"$SCRATCH/t.json" && mv "$SCRATCH/t.json" "$SCRATCH/agents-hc.json"
  : >"$HCLOG"
  hc_ask -a opencode "PING" >/dev/null 2>&1
  grep -qx run "$HCLOG"; check "config backend hc selects hc" $?
  : >"$HCLOG"
  hc_ask --backend subprocess -a opencode "PING" >/dev/null 2>&1
  [[ ! -s "$HCLOG" ]]; check "--backend subprocess overrides the config" $?
  hc_cfg "$SCRATCH/hc-wrap"

  # Exit code and stderr of the agent survive hc: a quota error on stderr sets the cooldown.
  cat >"$SCRATCH/quota-stub" <<'EOF'
#!/usr/bin/env bash
echo "429 Too Many Requests" >&2; exit 1
EOF
  chmod +x "$SCRATCH/quota-stub"
  jq --arg s "$SCRATCH/quota-stub" '.agents.opencode.command = $s' "$SCRATCH/agents-hc.json" >"$SCRATCH/t.json"
  XDG_CACHE_HOME="$SCRATCH/cache-q" ASK_AGENT_CONFIG="$SCRATCH/t.json" "$ASK" --backend hc -a opencode "PING" >/dev/null 2>"$SCRATCH/err"
  grep -q 'opencode hit a quota/rate limit' "$SCRATCH/err"; check "hc backend keeps the agent's stderr and exit code" $?

  # The per-agent timeout still kills the agent under hc.
  cat >"$SCRATCH/slow-stub" <<'EOF'
#!/usr/bin/env bash
sleep 60
EOF
  chmod +x "$SCRATCH/slow-stub"
  jq --arg s "$SCRATCH/slow-stub" '.agents.opencode.command = $s | .agents.opencode.timeout_seconds = 2' \
    "$SCRATCH/agents-hc.json" >"$SCRATCH/t.json"
  start=$SECONDS
  ASK_AGENT_CONFIG="$SCRATCH/t.json" "$ASK" --backend hc -a opencode "PING" >/dev/null 2>"$SCRATCH/err"
  grep -q 'opencode timed out after 2s' "$SCRATCH/err" && ((SECONDS - start < 20)); check "hc backend enforces the timeout" $?
  hc ls --all --json | jq -e '[.terminals[]? | select((.name // "") | startswith("aa-"))] | length == 0' >/dev/null
  check "hc backend removes a timed-out terminal" $?

  # No usable hc: fall back to the subprocess backend.
  hc_cfg "$SCRATCH/no-such-hc"
  out="$(hc_ask --backend hc -a gentle-shell "PING" 2>"$SCRATCH/err")"
  [[ "$out" == "$sub" ]] && grep -q 'falling back to subprocess' "$SCRATCH/err"; check "missing hc falls back to subprocess" $?
else
  echo "SKIP: hc not installed, hc backend tests not run"
fi

# An agent asked by name falls back to its configured fallback when it hits its quota.
QUOTA_STUB="$SCRATCH/quota-stub"
printf '#!/usr/bin/env bash\necho "Free usage limit reached" >&2\nexit 1\n' >"$QUOTA_STUB"
chmod +x "$QUOTA_STUB"
jq --arg q "$QUOTA_STUB" '.agents.opencode.command = $q' "$ASK_AGENT_CONFIG" >"$SCRATCH/fb.json"
out="$(XDG_CACHE_HOME="$SCRATCH/cache-fb" ASK_AGENT_CONFIG="$SCRATCH/fb.json" "$ASK" -a opencode "PING" 2>"$SCRATCH/err")"
[[ "$out" == *"PING"* && "$out" == *"you are read-only"* ]]; check "opencode out of quota falls back to agy" $?
# Once in cooldown, opencode is skipped and agy answers directly.
out="$(XDG_CACHE_HOME="$SCRATCH/cache-fb" ASK_AGENT_CONFIG="$SCRATCH/fb.json" "$ASK" -a opencode "PING" 2>"$SCRATCH/err")"
[[ "$out" == *"PING"* ]] && grep -q 'skip opencode' "$SCRATCH/err"; check "opencode in cooldown is skipped for agy" $?
# An agent without a fallback still fails alone (previous behavior).
jq --arg q "$QUOTA_STUB" '.agents.codex.command = $q' "$ASK_AGENT_CONFIG" >"$SCRATCH/nofb.json"
XDG_CACHE_HOME="$SCRATCH/cache-nofb" ASK_AGENT_CONFIG="$SCRATCH/nofb.json" "$ASK" -a codex "PING" >/dev/null 2>&1
[[ $? != 0 ]]; check "agent without fallback still fails" $?

# Every run is appended to runs.jsonl with its directory, exit, prompt and the files it changed.
WRITER="$SCRATCH/writer-stub"
printf '#!/usr/bin/env bash\necho hi >made.txt\necho "wrote made.txt"\n' >"$WRITER"
chmod +x "$WRITER"
jq --arg w "$WRITER" '.agents."gentle-shell".command = $w' "$ASK_AGENT_CONFIG" >"$SCRATCH/writer.json"
REPO="$SCRATCH/repo"
git init -q "$REPO" && git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
RUNS="$SCRATCH/cache-runs/multi-agent-router/runs.jsonl"
XDG_CACHE_HOME="$SCRATCH/cache-runs" ASK_AGENT_CONFIG="$SCRATCH/writer.json" \
  "$ASK" -a gentle-shell -C "$REPO" "WRITE TASK" >/dev/null 2>&1
[[ "$(wc -l <"$RUNS")" -eq 1 ]]; check "a run appends one line to runs.jsonl" $?
jq -e --arg d "$(cd "$REPO" && pwd -P)" '.agent == "gentle-shell" and .exit == 0 and .cwd == $d
  and (.prompt | contains("WRITE TASK")) and (.answer | contains("wrote made.txt"))' "$RUNS" >/dev/null
check "run record has agent, cwd, exit, prompt and answer" $?
jq -e '.changed_files == ["made.txt"]' "$RUNS" >/dev/null; check "run record lists the files the agent changed" $?
# A failed attempt is recorded too, and the history keeps both runs.
XDG_CACHE_HOME="$SCRATCH/cache-runs" ASK_AGENT_CONFIG="$SCRATCH/nofb.json" "$ASK" -a codex "PING" >/dev/null 2>&1
[[ "$(wc -l <"$RUNS")" -eq 2 ]] && jq -se '.[1].agent == "codex" and .[1].exit != 0' "$RUNS" >/dev/null
check "failed runs are recorded and history is kept" $?
# `ask-agent runs` lists the history, newest last, filterable by agent.
out="$(XDG_CACHE_HOME="$SCRATCH/cache-runs" "$ASK" runs 2>&1)"
[[ "$out" == *"gentle-shell"*"codex"* && "$out" == *"WRITE TASK"* ]]; check "runs lists the history" $?
out="$(XDG_CACHE_HOME="$SCRATCH/cache-runs" "$ASK" runs -a codex 2>&1)"
[[ "$out" == *"codex"* && "$out" != *"gentle-shell"* ]]; check "runs -a filters by agent" $?
out="$(XDG_CACHE_HOME="$SCRATCH/cache-runs" "$ASK" runs 1 2>&1)"
[[ "$out" == *"codex"* && "$out" != *"WRITE TASK"* ]]; check "runs N shows only the last N" $?
# `runs -a` without a value fails fast instead of looping.
XDG_CACHE_HOME="$SCRATCH/cache-runs" timeout 5 "$ASK" runs -a >/dev/null 2>&1
[[ $? == 2 ]]; check "runs -a without a value exits 2" $?
# A corrupt line in runs.jsonl does not break the listing.
echo '{"broken' >>"$RUNS"
out="$(XDG_CACHE_HOME="$SCRATCH/cache-runs" "$ASK" runs 2>&1)"
[[ "$out" == *"gentle-shell"*"codex"* ]]; check "runs skips corrupt lines" $?
# The last/ snapshot per agent still exists (previous behavior).
[[ -s "$SCRATCH/cache-runs/multi-agent-router/last/gentle-shell.json" ]]; check "last/ snapshot still written" $?

# Unknown backend is rejected.
"$ASK" --backend nope -a codex "PING" >/dev/null 2>&1; [[ $? == 2 ]]; check "unknown backend is rejected" $?

echo "ask-agent: $pass passed, $fail failed, $skipped skipped"
((fail == 0))
