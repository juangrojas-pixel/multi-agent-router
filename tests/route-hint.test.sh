#!/usr/bin/env bash
# Tests for bin/route-hint: prompt classification, hook output and decision log.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HINT="$ROOT/bin/route-hint"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
export XDG_CACHE_HOME="$SCRATCH/cache"
LOG="$XDG_CACHE_HOME/multi-agent-router/route.jsonl"

pass=0 fail=0
check() { # name, condition result (0 ok)
  if [[ "$2" == 0 ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi
}

hint() { jq -n --arg p "$1" '{prompt: $p}' | "$HINT"; }
context() { hint "$1" | jq -r '.hookSpecificOutput.additionalContext // ""'; }
last_rule() { tail -n 1 "$LOG" | jq -r '.rule'; }

# Routed prompts get a concrete directive naming the agent.
out="$(context "que conviene mas para esta arquitectura, colas o cron?")"
[[ "$out" == *'ask-agent -a gentle-shell'* ]]; check "architecture routes to gentle-shell" $?
[[ "$(last_rule)" == design ]]; check "architecture logs rule design" $?

out="$(context "puedes pensar un poco y decirme que otros tipos de informe podrian surgir")"
[[ "$out" == *'ask-agent -a gentle-shell'* ]]; check "open thinking routes to gentle-shell" $?

out="$(context "que falta para terminar de dejar el harness bien configurado")"
[[ "$out" == *'ask-agent -a gentle-shell'* ]]; check "gap analysis routes to gentle-shell" $?

out="$(context "dame una segunda opinion sobre este enfoque")"
[[ "$out" == *'ask-agent -a codex'* ]]; check "second opinion routes to codex" $?

out="$(context "escribi un README y un changelog para esto")"
[[ "$out" == *'ask-agent -a opencode'* ]]; check "docs route to opencode" $?

out="$(context "arma el .md siguiendo la plantilla del informe")"
[[ "$out" == *'ask-agent -a agy'* ]]; check "template work routes to agy" $?

out="$(context "apoyate en los demas agentes para el informe de croydon")"
[[ "$out" == *'ask-agent -a gentle-shell'* ]]; check "explicit delegation routes to gentle-shell" $?
[[ "$(last_rule)" == explicit-delegate ]]; check "explicit delegation beats client names" $?

out="$(context "pasalo a PDF y subelo a drive")"
[[ "$out" == *'ask-agent -a agy'* ]]; check "pdf/drive routes to agy" $?
[[ "$(last_rule)" == report-doc ]]; check "pdf/drive logs report-doc" $?

out="$(context "puedes responder este correo que me piden estatus")"
[[ "$out" == *'ask-agent -a agy'* ]]; check "email reply routes to agy" $?
[[ "$(last_rule)" == client-text ]]; check "email reply logs client-text" $?

out="$(context "como se calculan los contenedores en jde")"
[[ "$out" == *'ask-agent -a gentle-shell'* && "$out" == *'handoff/actual'* ]]; check "client question routes to gentle-shell with handoff" $?
[[ "$(last_rule)" == client-work ]]; check "client question logs client-work" $?

out="$(context "revisa la arquitectura del servidor de richmond por ssh")"
[[ "$out" == *'ask-agent -a gentle-shell'* ]]; check "client server review routes to gentle-shell" $?

out="$(context "cual es la mejor ruta para hacerlo")"
[[ "$out" == *'ask-agent -a gentle-shell'* ]]; check "planning question routes to gentle-shell" $?
[[ "$(last_rule)" == design ]]; check "planning question logs design" $?

# Inline guards win over routing rules.
out="$(context "reinicia el servidor de richmond")"
[[ "$out" != *'ask-agent -a'* ]]; check "server restart stays inline" $?
[[ "$(last_rule)" == inline-sensitive ]]; check "restart logs inline-sensitive" $?

out="$(context "pasame el password de la bd de croydon")"
[[ "$out" != *'ask-agent -a'* ]]; check "secret stays inline" $?

out="$(context "sin delegar: que conviene en esta arquitectura")"
[[ "$out" != *'ask-agent -a'* ]]; check "sin delegar stays inline" $?

# Unmatched prompts get the short general policy, not a directive.
out="$(context "hola, como va")"
[[ "$out" == *'AUTO-ROUTING'* && "$out" != *'ROUTE NOW'* ]]; check "unmatched gets general policy" $?
[[ "$(last_rule)" == none ]]; check "unmatched logs none" $?

# Slash commands are left alone and not logged.
before="$(wc -l <"$LOG")"
out="$(hint "/caveman ultra")"
[[ -z "$out" ]]; check "slash command emits nothing" $?
[[ "$(wc -l <"$LOG")" == "$before" ]]; check "slash command not logged" $?

# System notifications (background task events) are not user prompts.
before="$(wc -l <"$LOG")"
out="$(hint $'<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification><summary>done</summary></task-notification>\n</system-reminder>')"
[[ -z "$out" ]]; check "system notification emits nothing" $?
[[ "$(wc -l <"$LOG")" == "$before" ]]; check "system notification not logged" $?

# The log never stores prompt text.
! rg -q 'richmond|arquitectura' "$LOG"; check "log holds no prompt text" $?

# Output is valid hook JSON.
hint "que conviene mas" | jq -e '.hookSpecificOutput.hookEventName == "UserPromptSubmit"' >/dev/null
check "valid hook json" $?

# An agent in cooldown (out of quota) is not routed to until the cooldown expires.
mkdir -p "$XDG_CACHE_HOME/multi-agent-router"
echo "{\"gentle-shell\": $(($(date +%s) + 600))}" >"$XDG_CACHE_HOME/multi-agent-router/cooldown.json"
out="$(context "que conviene mas para esta arquitectura")"
[[ "$out" != *'ROUTE NOW'* && "$out" == *'gentle-shell'*'cooldown'* ]]; check "cooled-down agent is skipped" $?
[[ "$(tail -n 1 "$LOG" | jq -r '.cooldown')" == true ]]; check "skip logs cooldown true" $?

echo "{\"gentle-shell\": $(($(date +%s) - 10))}" >"$XDG_CACHE_HOME/multi-agent-router/cooldown.json"
out="$(context "que conviene mas para esta arquitectura")"
[[ "$out" == *'ask-agent -a gentle-shell'* ]]; check "expired cooldown routes again" $?

echo '{"agy": 9999999999}' >"$XDG_CACHE_HOME/multi-agent-router/cooldown.json"
out="$(context "que conviene mas para esta arquitectura")"
[[ "$out" == *'ask-agent -a gentle-shell'* ]]; check "other agent's cooldown does not block" $?
rm -f "$XDG_CACHE_HOME/multi-agent-router/cooldown.json"

# Unmatched prompts get the generated role guidance followed by the routing notes.
out="$(context "hola, como va")"
[[ "$out" == *'ask-agent-ts -r coder -C <dir>'* && "$out" == *'AUTO-ROUTING'* ]]; check "unmatched gets role guidance and notes" $?

# A rule naming a role routes through ask-agent-ts -r; an agent rule keeps its directive.
ROLECFG="$SCRATCH/role.json"
jq '.routing.rules = [{id: "role-test", match: "zzrolecheck", role: "coder", verify: "VERIFY-IT"}] + .routing.rules' \
  "$ROOT/agents.json" >"$ROLECFG"
rcontext() { jq -n --arg p "$1" '{prompt: $p}' | ASK_AGENT_CONFIG="$ROLECFG" "$HINT" | jq -r '.hookSpecificOutput.additionalContext // ""'; }
out="$(rcontext "zzrolecheck please")"
[[ "$out" == *'ROUTE NOW'* && "$out" == *'ask-agent-ts -r coder -C <dir>'* && "$out" != *'ask-agent -a'* && "$out" == *'VERIFY-IT'* ]]
check "role rule routes with ask-agent-ts -r" $?
[[ "$(tail -n 1 "$LOG" | jq -r '.role')" == coder ]]; check "role rule logs its role" $?
out="$(rcontext "que conviene mas para esta arquitectura")"
[[ "$out" == *'ask-agent -a gentle-shell -C <dir>'* ]]; check "agent rule unchanged next to a role rule" $?

# A role rule skips delegation only when every agent of the role is in cooldown.
echo "{\"gentle-shell\": $(($(date +%s) + 600))}" >"$XDG_CACHE_HOME/multi-agent-router/cooldown.json"
out="$(rcontext "zzrolecheck please")"
[[ "$out" == *'ROUTE NOW'* ]]; check "role with one ready agent still routes" $?
echo "{\"gentle-shell\": $(($(date +%s) + 600)), \"agy\": $(($(date +%s) + 900))}" >"$XDG_CACHE_HOME/multi-agent-router/cooldown.json"
out="$(rcontext "zzrolecheck please")"
[[ "$out" == 'SKIP DELEGATION'*'role coder'*'cooldown'* && "$out" != *'ROUTE NOW'* ]]; check "role with every agent cooling down is skipped" $?
[[ "$(tail -n 1 "$LOG" | jq -r '.cooldown')" == true ]]; check "role skip logs cooldown true" $?
rm -f "$XDG_CACHE_HOME/multi-agent-router/cooldown.json"

# When the guidance command fails or prints nothing, unmatched prompts fall back to routing.general.
BADCFG="$SCRATCH/bad.json"
jq '.roles.coder.agents = ["ghost"] | .routing.general = "GENERAL-FALLBACK"' "$ROOT/agents.json" >"$BADCFG"
out="$(jq -n '{prompt: "hola, como va"}' | ASK_AGENT_CONFIG="$BADCFG" "$HINT" | jq -r '.hookSpecificOutput.additionalContext')"
[[ "$out" == 'GENERAL-FALLBACK' ]]; check "failing guidance falls back to general" $?
EMPTYCFG="$SCRATCH/empty.json"
jq 'del(.roles) | del(.routing.notes) | .routing.general = "GENERAL-FALLBACK"' "$ROOT/agents.json" >"$EMPTYCFG"
out="$(jq -n '{prompt: "hola, como va"}' | ASK_AGENT_CONFIG="$EMPTYCFG" "$HINT" | jq -r '.hookSpecificOutput.additionalContext')"
[[ "$out" == 'GENERAL-FALLBACK' ]]; check "empty guidance falls back to general" $?

# --stats summarizes the log per rule.
"$HINT" --stats | rg -q 'design'; check "stats lists rules" $?

echo "route-hint: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
