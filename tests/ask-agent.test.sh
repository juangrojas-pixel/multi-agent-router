#!/usr/bin/env bash
# Tests for bin/ask-agent: per-agent prompt preamble (executor vs read-only advisor).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASK="$ROOT/bin/ask-agent"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
export XDG_CACHE_HOME="$SCRATCH/cache"

pass=0 fail=0
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

# Only gentle-shell may work on client servers, and it stops on a guard confirmation.
out="$(ask gentle-shell)"
[[ "$out" == *"client servers"* && "$out" == *"CONFIRMACION REQUERIDA"* ]]; check "gentle-shell may reach clients and reports confirmations" $?
out="$(ask agy)"
[[ "$out" == *"you are read-only"* ]]; check "agy is read-only on client servers" $?
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

echo "ask-agent: $pass passed, $fail failed"
((fail == 0))
