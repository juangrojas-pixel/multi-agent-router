# Quickstart: Agentic Dispatcher

Validation guide. Commands and outputs are defined in [contracts/cli.md](contracts/cli.md).

## Automated (no network, no real agents)

```bash
cd ~/Proyectos/multi-agent-router
node --test --test-reporter=tap tests/*.test.ts
bash tests/ask-agent.test.sh      # parity contract stays green
```

Tests use stub agents and `file://` fixture sources under `tests/fixtures/benchmarks/`.

## Manual end-to-end (real agents; read-only, no quota spent)

1. `ask-agent preflight` shows versions, quotas, freshness; exit 0 or 3 with update commands.
2. `ask-agent catalog --refresh` lists usable models per agent and benchmark sources with dates.
   Check: no model shown as `usable` that its CLI did not list.
3. `ask-agent candidates --kind code --tier standard --size m` puts the cheapest capable model
   first; anything over `cost_ceiling` is flagged.

## Manual end-to-end (spends small quota)

4. Batch with two distinct tasks to two agents, disjoint `writes`, in a scratch directory:
   ```bash
   ask-agent dispatch -f batch.json
   ```
   Give each task a `reason`. Expect two receipts and two `runs.jsonl` entries with `batch_id`, `task_id`, `reason`.
5. Same batch with overlapping `writes`: exit 2 before any agent starts.
