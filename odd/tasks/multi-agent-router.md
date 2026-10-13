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
- [ ] T2 Plugin packaging: manifest, subagents, delegate skill, local marketplace install

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
