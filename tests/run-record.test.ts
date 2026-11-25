import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseConfig, fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

type AnyConfig = { agents: Record<string, Record<string, unknown>>; roles?: object };

function argvConfig(extra: Record<string, unknown> = {}): AnyConfig {
  const config = baseConfig() as AnyConfig;
  config.agents.argv = {
    enabled: true,
    command: fixture("stub-argv"),
    timeout_seconds: 1,
    model: "agent-model",
    models: ["agent-model", "m-small", "m-big"],
    args: ["{model_args}", "{prompt}"],
    model_args: ["--model", "{model}"],
    output: "text",
    ...extra,
  };
  return config;
}

function runs(root: string): Array<Record<string, unknown>> {
  const path = join(root, "cache", "multi-agent-router", "runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function writeCatalog(root: string, catalog: object): void {
  const dir = join(root, "cache", "multi-agent-router");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "catalog.json"), JSON.stringify(catalog));
}

test("-a -m with --task and --reason records them with the requested model", () => {
  const s = scratchConfig(argvConfig());
  const result = runCli(["-a", "argv", "-m", "m-small", "--task", "T2", "--reason", "light edit, small model is enough", "hello"], s.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "--model\nm-small\nhello\n");
  const [row] = runs(s.root);
  assert.equal(row.agent, "argv");
  assert.equal(row.model, "m-small");
  assert.equal(row.requested_model, "m-small");
  assert.equal(row.model_source, "requested");
  assert.equal(row.task_id, "T2");
  assert.equal(row.reason, "light edit, small model is enough");
  for (const key of ["ts", "tier", "role", "cwd", "exit", "seconds", "prompt", "prompt_chars", "answer", "changed_files"]) {
    assert.ok(key in row, `existing field ${key} kept`);
  }
});

test("a run without -m records an empty requested_model and the agent's model", () => {
  const s = scratchConfig(argvConfig());
  const result = runCli(["-a", "argv", "hello"], s.env);
  assert.equal(result.status, 0, result.stderr);
  const [row] = runs(s.root);
  assert.equal(row.model, "agent-model");
  assert.equal(row.requested_model, "");
  assert.equal(row.task_id, undefined);
  assert.equal(row.reason, undefined);
});

test("a model outside the agent's config models stops before the agent starts", () => {
  const s = scratchConfig(argvConfig());
  const result = runCli(["-a", "argv", "-m", "m-ghost", "hello"], s.env);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "[ask-agent] model m-ghost is not usable for agent argv (not in agents.argv.models)\n");
  assert.deepEqual(runs(s.root), []);
});

test("an agent without config models accepts any -m when no catalog exists", () => {
  const s = scratchConfig(argvConfig({ models: undefined }));
  const result = runCli(["-a", "argv", "-m", "anything", "hello"], s.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "--model\nanything\nhello\n");
});

test("the catalog status wins over config models when the catalog lists the agent", () => {
  const s = scratchConfig(argvConfig());
  writeCatalog(s.root, { agents: { argv: { fetched_at: "2026-11-25T00:00:00Z", source: "cli", models: [
    { id: "m-small", status: "usable" },
    { id: "m-big", status: "out_of_quota", quota_group: "G", quota_left: 0 },
  ] } } });
  const blocked = runCli(["-a", "argv", "-m", "m-big", "hello"], s.env);
  assert.equal(blocked.status, 2);
  assert.equal(blocked.stderr, "[ask-agent] model m-big is not usable for agent argv (out_of_quota)\n");
  const missing = runCli(["-a", "argv", "-m", "agent-model", "hello"], s.env);
  assert.equal(missing.status, 2);
  assert.equal(missing.stderr, "[ask-agent] model agent-model is not usable for agent argv (not in catalog)\n");
  const ok = runCli(["-a", "argv", "-m", "m-small", "hello"], s.env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(runs(s.root).length, 1);
});

test("an unverified catalog entry is allowed", () => {
  const s = scratchConfig(argvConfig());
  writeCatalog(s.root, { agents: { argv: { fetched_at: "2026-11-25T00:00:00Z", source: "config", models: [
    { id: "m-small", status: "unverified" },
  ] } } });
  const result = runCli(["-a", "argv", "-m", "m-small", "hello"], s.env);
  assert.equal(result.status, 0, result.stderr);
});

test("--task and --reason need a value", () => {
  const s = scratchConfig(argvConfig());
  for (const flag of ["--task", "--reason"]) {
    const result = runCli(["-a", "argv", flag], s.env);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, `[ask-agent] error: unknown option: ${flag}\n`);
  }
});

test("regression FR-014: -r ROLE without -m still runs the role's agent and model", () => {
  const config = argvConfig();
  config.roles = { coder: { description: "d", agents: [{ agent: "argv", model: "m-big" }] } };
  const s = scratchConfig(config);
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "--model\nm-big\nhello\n");
  const [row] = runs(s.root);
  assert.equal(row.role, "coder");
  assert.equal(row.model, "m-big");
});

test("gentle-shell with a config model and no -m passes --model after --", () => {
  const config = baseConfig() as AnyConfig;
  config.agents["gentle-shell"] = { enabled: true, command: fixture("stub-argv"), timeout_seconds: 1, model: "openai-codex/gpt-x-sol" };
  const s = scratchConfig(config);
  const result = runCli(["-a", "gentle-shell", "hello"], s.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "--\n-p\n--no-session\n--model\nopenai-codex/gpt-x-sol\nhello\n");
});
