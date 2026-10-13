# multi-agent-router

## Objective
Let Claude Code delegate prompts to other agent CLIs (agy, opencode, gentle-shell) through one quota-aware router, then package it as a Claude Code plugin.

## Scope
- `bin/ask-agent`: router with agent chain, per-agent enable flag, proactive quota check (agy `/usage`), reactive quota-error fallback, cooldown cache.
- `agents.json`: chain order, models, thresholds, enabled flags.
- Plugin packaging (manifest, subagents, delegate skill) after the router is proven.

## Constraints
- gentle-shell registered but disabled for now.
- opencode defaults to a free `opencode/*` model to save Claude tokens.
- No remaining-quota API for opencode/gentle-shell: reactive fallback only.

## Tasks
- [x] T1 Router script + config, verified against live agy and opencode (route: inline, single mechanical script)
- [x] T2 Plugin packaging: manifest, subagents, delegate skill, local marketplace install (route: inline; prose/config files already designed)

## Acceptance
- `ask-agent status` shows availability and agy quota.
- `ask-agent -a agy|opencode "<prompt>"` returns the agent's answer on stdout.
- `ask-agent "<prompt>"` walks the chain, skipping disabled / low-quota / cooled-down agents.

## Progress
- Verified: `agy -p "/usage" --output-format json` returns quota JSON with 0 tokens.
- Verified: `opencode run -m <model>` headless; free models under `opencode/*`.
- Verified: `gentle-shell -- -p --mode json --no-session` headless forwarding.

## Verification (T1)
- `bin/ask-agent status`: agy ready (quota shown), opencode ready, gentle-shell skip: disabled.
- `bin/ask-agent -a agy "Reply with exactly: AGY_OK"` -> `AGY_OK`.
- `bin/ask-agent -a opencode "Reply with exactly: OPENCODE_OK"` -> `OPENCODE_OK`.
- Fallback with `min_remaining = 1.1` (isolated cache): agy skipped, opencode answered `FALLBACK_OK`, agy cooldown set to its reset time.
- Not exercised: real quota-error output from a CLI (regex fallback), gentle-shell invocation (disabled).

## Next step
T2: package as Claude Code plugin.

## Fixes after T1 (gentle-shell enabled)
- Enabled gentle-shell (default model openai-codex/gpt-6.1-sol via ChatGPT subscription).
- Bug: `run_agent` clobbered caller loop var `a` (bash dynamic scope) -> cooldown saved under empty name. Fixed with `local arg`.
- Bug: agents could hang forever (pi waited on stdin; wrapper node -> pi child survived kill). Added `with_timeout`: own process group, stdin </dev/null, TERM/KILL whole group, exit 142. Per-agent `timeout_seconds`.
- Verified: real quota error from gentle-shell ("Codex error: The usage limit has been reached") detected in ~12s, cooldown keyed correctly, no orphans.
- Verified: fake agent with background child killed after 3s, child gone.
- Observed (not ours to fix here): gentle-shell auto-setup fails on rollback snapshot restore; it continues anyway.

## Router v2: tiers, codex (bare pi), parallel
- Tiers in agents.json: think [codex, agy], execute [agy, codex], draft [opencode, agy]; gentle-shell explicit only.
- `codex` = `pi -p --no-session --no-extensions --no-skills --no-context-files --model openai-codex/gpt-6.1-sol --tools read,grep,find,ls` (no gentle-ai setup/orchestrator).
- Read-only by default: agy `--mode plan`, opencode `--agent plan` + `--format json` (text events parsed), codex tool allowlist.
- `ask-agent parallel` runs every ready agent concurrently and prints `### agent` sections.
- Verified: status shows tiers; draft -> opencode `DRAFT_OK`; codex quota error detected in 5s (was 12s via gentle-shell, no setup noise); parallel agy+opencode answered in ~18s; think tier skipped cooled-down codex and agy answered `THINK_OK`.
- Not verified: codex successful answer (ChatGPT quota exhausted 2026-10-12).

## Verification (T2)
- `claude plugin validate .`: passed (hooks session.start, prompt.compose; calls $.process.run, $.ui.log, $.ui.status).
- `claude plugin test .`: 1 pass (policy section appended last, scope session).
- Installed: `multi-agent-router@multi-agent-router`, scope user, read from repo folder, enabled.
- Bug found and fixed: ask-agent via ~/.local/bin symlink resolved ROOT to ~/.local; now resolves with `readlink -f`.
- Not verified yet: hook running in a live session (needs `/reload-plugins` or new session), subagents end to end.

## First real second opinion (agy reviewing bin/ask-agent)
- Finding: agy in `-p` runs shell commands autonomously (ran `./bin/ask-agent status`, `agy -p /usage`) in plan mode and default mode alike; `--mode plan` does not make it read-only. Two runs hit 10m/5m timeouts with empty response.
- Fix: recursion guard via `ASK_AGENT_DEPTH`; global `prompt_preamble` (read-only, no commands, concise); dropped `--mode plan` for agy. Third run answered in 8m, no files changed.
- agy claims verified on bash 3.2.57: #1 empty-array/set -u FALSE, #2 readlink -f FALSE on this macOS (hardened with perl abs_path anyway), #3 missing `alarm 0` TRUE (fixed), #4 cooldown race in parallel TRUE (20 writers: 4/20 kept without lock, 20/20 with mkdir lock), #5 invalid agent ignored TRUE (agy's proposed fix also wrong: validation moved to parse_args in main shell), #6 model word splitting FALSE.
