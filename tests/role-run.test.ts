import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseConfig, fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

type AnyConfig = { agents: Record<string, object>; roles?: object };

function roleConfig(roles?: object): AnyConfig {
  const config = baseConfig() as AnyConfig;
  config.agents.argv = {
    enabled: true,
    command: fixture("stub-argv"),
    timeout_seconds: 1,
    model: "agent-model",
    args: ["{model_args}", "{effort_args}", "{prompt}"],
    model_args: ["--model", "{model}"],
    effort_args: ["--thinking", "{effort}"],
    effort_levels: ["low", "high"],
    output: "text",
  };
  if (roles) config.roles = roles;
  return config;
}

function runs(root: string): Array<Record<string, unknown>> {
  const path = join(root, "cache", "multi-agent-router", "runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("run by role reaches the role's agent and returns its answer", () => {
  const setup = scratchConfig(roleConfig({ coder: { description: "writes code", agents: ["one"] } }));
  const result = runCli(["-r", "coder", "hello"], setup.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
  assert.equal(result.stderr, "[ask-agent] using one\n");
});

test("--role is the long form of -r", () => {
  const setup = scratchConfig(roleConfig({ coder: { description: "writes code", agents: ["one"] } }));
  const result = runCli(["--role", "coder", "hello"], setup.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
});

test("role model and effort reach the agent through model_args and effort_args", () => {
  const setup = scratchConfig(roleConfig({ coder: { description: "d", agents: ["argv"], model: "role-model", effort: "high" } }));
  const result = runCli(["-r", "coder", "hello"], setup.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "--model\nrole-model\n--thinking\nhigh\nhello\n");
});

test("the entry's own model and effort win over the role defaults", () => {
  const setup = scratchConfig(roleConfig({
    coder: { description: "d", agents: [{ agent: "argv", model: "entry-model", effort: "low" }], model: "role-model", effort: "high" },
  }));
  const result = runCli(["-r", "coder", "hello"], setup.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "--model\nentry-model\n--thinking\nlow\nhello\n");
});

test("a role with only an agent keeps the agent's own model and adds no effort", () => {
  const setup = scratchConfig(roleConfig({ coder: { description: "d", agents: ["argv"] } }));
  const result = runCli(["-r", "coder", "hello"], setup.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "--model\nagent-model\nhello\n");
});

test("unknown role exits 2, names the configured roles and starts no agent", () => {
  const setup = scratchConfig(roleConfig({ coder: { description: "d", agents: ["argv"] }, docs: { description: "d", agents: ["one"] } }));
  const result = runCli(["-r", "nope", "hello"], setup.env);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "[ask-agent] unknown role: nope (configured: coder, docs)\n");
  assert.deepEqual(runs(setup.root), []);
});

test("no roles configured exits 2", () => {
  const setup = scratchConfig(roleConfig());
  const result = runCli(["-r", "coder", "hello"], setup.env);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "[ask-agent] no roles configured\n");
  assert.deepEqual(runs(setup.root), []);
});

for (const extra of [["-a", "one"], ["-t", "execute"]]) {
  test(`-r with ${extra[0]} exits 2`, () => {
    const setup = scratchConfig(roleConfig({ coder: { description: "d", agents: ["one"] } }));
    const result = runCli(["-r", "coder", ...extra, "hello"], setup.env);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "[ask-agent] use only one of -r, -a, -t\n");
    assert.deepEqual(runs(setup.root), []);
  });
}

test("-r with -m exits 2 because the model comes from the role", () => {
  const setup = scratchConfig(roleConfig({ coder: { description: "d", agents: ["one"] } }));
  const result = runCli(["-r", "coder", "-m", "x", "hello"], setup.env);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "[ask-agent] use -r without -m: the model comes from the role\n");
  assert.deepEqual(runs(setup.root), []);
});

test("-a and -t calls are unchanged when roles are configured", () => {
  const setup = scratchConfig(roleConfig({ coder: { description: "d", agents: ["argv"] } }));
  const byAgent = runCli(["-a", "one", "hello"], setup.env);
  assert.equal(byAgent.status, 0);
  assert.equal(byAgent.stdout, "hello\n");
  const byTier = runCli(["-t", "execute", "hello"], setup.env);
  assert.equal(byTier.status, 0);
  assert.equal(byTier.stdout, "hello\n");
  assert.deepEqual(runs(setup.root).map((row) => row.role), ["", ""]);
});

test("runs.jsonl records the role of a role run", () => {
  const setup = scratchConfig(roleConfig({ coder: { description: "d", agents: ["one"] } }));
  runCli(["-r", "coder", "hello"], setup.env);
  const rows = runs(setup.root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "coder");
  assert.equal(rows[0].agent, "one");
});

test("a role's prompt_preamble goes after the agent's preamble and before the prompt", () => {
  const config = roleConfig({ reports: { description: "d", agents: ["argv"], prompt_preamble: "role rules" } });
  (config.agents.argv as Record<string, unknown>).prompt_preamble = "agent rules";
  const setup = scratchConfig(config);
  const result = runCli(["-r", "reports", "hello"], setup.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "--model\nagent-model\nagent rules\n\nrole rules\n\nhello\n");
});

test("a role without prompt_preamble keeps only the agent's preamble", () => {
  const config = roleConfig({ coder: { description: "d", agents: ["argv"] } });
  (config.agents.argv as Record<string, unknown>).prompt_preamble = "agent rules";
  const setup = scratchConfig(config);
  const result = runCli(["-r", "coder", "hello"], setup.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "--model\nagent-model\nagent rules\n\nhello\n");
});
