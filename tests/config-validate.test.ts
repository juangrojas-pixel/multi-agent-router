import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

function agent(extra: object = {}): object {
  return { enabled: true, command: fixture("stub-ok"), timeout_seconds: 1, args: ["{prompt}"], output: "text", ...extra };
}

function base(extra: object): object {
  return {
    default_tier: "execute",
    tiers: { execute: ["one"] },
    agents: {
      one: agent({ models: ["m1", "m2"], effort_args: ["--e", "{effort}"], effort_levels: ["low", "high"] }),
      plain: agent(),
    },
    ...extra,
  };
}

const cases: Array<[string, object, string]> = [
  ["role with no agents", { roles: { coder: { description: "d", agents: [] } } },
    "config: roles.coder.agents: role has no agents"],
  ["entry naming an unknown agent", { roles: { coder: { description: "d", agents: ["one", "ghost"] } } },
    "config: roles.coder.agents[1]: unknown agent: ghost"],
  ["model not in the agent's models", { roles: { coder: { description: "d", agents: [{ agent: "one", model: "m9" }] } } },
    "config: roles.coder.agents[0]: model m9 is not in agents.one.models"],
  ["role default model not in the agent's models", { roles: { coder: { description: "d", agents: ["one"], model: "m9" } } },
    "config: roles.coder.agents[0]: model m9 is not in agents.one.models"],
  ["effort on an agent with no effort_levels", { roles: { coder: { description: "d", agents: ["plain"], effort: "high" } } },
    "config: roles.coder.agents[0]: agent plain has no effort_levels"],
  ["effort level not in effort_levels", { roles: { coder: { description: "d", agents: [{ agent: "one", effort: "max" }] } } },
    "config: roles.coder.agents[0]: effort max is not in agents.one.effort_levels"],
  ["unknown orchestrator agent", { orchestrator: { agent: "ghost" } },
    "config: orchestrator.agent: unknown agent: ghost"],
  ["unknown routing rule role", { roles: { coder: { description: "d", agents: ["one"] } }, routing: { rules: [{ id: "a" }, { id: "b", role: "ghost" }] } },
    "config: routing.rules[1].role: unknown role: ghost"],
];

for (const [name, extra, message] of cases) {
  test(`${name} stops every command before any agent starts`, () => {
    const s = scratchConfig(base(extra));
    for (const args of [["-a", "one", "hello"], ["roles"], ["status"]]) {
      const result = runCli(args, s.env);
      assert.equal(result.status, 2, `${args.join(" ")}`);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `[ask-agent] ${message}\n`);
    }
    assert.equal(existsSync(join(s.root, "cache", "multi-agent-router", "runs.jsonl")), false);
  });
}

test("unknown output parser stops every command", () => {
  const config = base({}) as { agents: Record<string, Record<string, unknown>> };
  config.agents.plain.output = "xml";
  const s = scratchConfig(config);
  const result = runCli(["-a", "one", "hello"], s.env);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "[ask-agent] config: agents.plain.output: unknown output: xml (use text, agy-json or opencode-events)\n");
});

test("a duplicate agent in a role is not an error and is tried once", () => {
  const s = scratchConfig(base({ roles: { coder: { description: "d", agents: ["one", "one"] } } }));
  const result = runCli(["roles"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.split("\n").filter(Boolean).length, 1);
});

test("a valid role with effort and model passes validation and runs", () => {
  const s = scratchConfig(base({ roles: { coder: { description: "d", agents: [{ agent: "one", model: "m2", effort: "low" }] } } }));
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
});
