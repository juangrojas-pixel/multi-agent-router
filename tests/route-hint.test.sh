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

# Inline guards win over routing rules.
out="$(context "revisa la arquitectura del servidor de richmond por ssh")"
[[ "$out" != *'ask-agent -a'* ]]; check "client/server prompt stays inline" $?
[[ "$(last_rule)" == inline-sensitive ]]; check "client prompt logs inline-sensitive" $?

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

# --stats summarizes the log per rule.
"$HINT" --stats | rg -q 'design'; check "stats lists rules" $?

echo "route-hint: $pass passed, $fail failed"
[[ "$fail" == 0 ]]
