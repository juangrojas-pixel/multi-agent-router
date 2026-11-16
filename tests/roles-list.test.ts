import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

const FUTURE = Date.parse("2030-01-01T00:00:00Z") / 1000;

function agent(extra: object = {}): object {
  return { enabled: true, command: fixture("stub-ok"), timeout_seconds: 1, args: ["{prompt}"], output: "text", ...extra };
}

function setup(config: object) {
  const scratch = scratchConfig(config);
  return { ...scratch, env: { ...scratch.env, TZ: "UTC" } };
}

const agents = {
  one: agent({ model: "one-default", effort_args: ["--e", "{effort}"], effort_levels: ["low", "high"] }),
  off: agent({ enabled: false }),
  missing: agent({ command: "/definitely/missing/agent" }),
  cool: agent(),
};

test("roles lists each entry with model, effort and readiness, exit 0 even when some are not ready", () => {
  const s = setup({
    agents,
    roles: {
      coder: { description: "d", agents: [{ agent: "one", effort: "high" }, "off"], model: "role-model" },
      docs: { description: "d", agents: ["missing", "cool", "one"] },
    },
  });
  mkdirSync(join(s.root, "cache", "multi-agent-router"), { recursive: true });
  writeFileSync(join(s.root, "cache", "multi-agent-router", "cooldown.json"), JSON.stringify({ cool: FUTURE }));
  const result = runCli(["roles"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, [
    "coder\tone\trole-model\thigh\tyes\t",
    "coder\toff\trole-model\t-\tno\tdisabled",
    "docs\tmissing\t-\t-\tno\tnot installed",
    "docs\tcool\t-\t-\tno\tcooldown until 00:00",
    "docs\tone\tone-default\t-\tyes\t",
    "",
  ].join("\n"));
});

test("roles prints the orchestrator first, and that agent may also hold a role", () => {
  const s = setup({ agents, orchestrator: { agent: "one" }, roles: { coder: { description: "d", agents: ["one"] } } });
  const result = runCli(["roles"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "orchestrator\tone\ncoder\tone\tone-default\t-\tyes\t\n");
});

test("the orchestrator agent runs like any other entry of a role", () => {
  const s = setup({ agents, orchestrator: { agent: "one" }, roles: { coder: { description: "d", agents: ["one"] } } });
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
});

test("roles with no roles configured prints nothing and exits 0", () => {
  const s = setup({ agents });
  const result = runCli(["roles"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(join(s.root, "cache", "multi-agent-router", "runs.jsonl")), false);
});
