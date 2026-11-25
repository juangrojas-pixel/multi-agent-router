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

function printConfig(output: string, model = "m1"): AnyConfig {
  const config = baseConfig() as AnyConfig;
  config.agents.p = { enabled: true, command: fixture("stub-print"), timeout_seconds: 5, model, args: ["{prompt}"], output };
  return config;
}

test("claude-json answers .result and records the reported model and tokens", () => {
  const s = scratchConfig(printConfig("claude-json", "haiku"));
  const out = JSON.stringify({ type: "result", result: "OK", total_cost_usd: 0.01, usage: { input_tokens: 2, output_tokens: 4 },
    modelUsage: { "claude-haiku-5-5": { outputTokens: 4 } } });
  const result = runCli(["-a", "p", "hello"], { ...s.env, STUB_OUTPUT: out });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "OK\n");
  const [row] = runs(s.root);
  assert.equal(row.model, "claude-haiku-5-5");
  assert.equal(row.requested_model, "");
  assert.equal(row.model_source, "reported");
  assert.equal(row.tokens_in, 2);
  assert.equal(row.tokens_out, 4);
});

test("claude-json with is_error gives no answer", () => {
  const s = scratchConfig(printConfig("claude-json"));
  const out = JSON.stringify({ type: "result", is_error: true, result: "boom" });
  const result = runCli(["-a", "p", "hello"], { ...s.env, STUB_OUTPUT: out });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
});

test("agy-json and opencode-events record tokens; the model stays requested", () => {
  const agy = scratchConfig(printConfig("agy-json"));
  const agyOut = JSON.stringify({ status: "SUCCESS", response: "OK\n", usage: { input_tokens: 10, output_tokens: 1, thinking_tokens: 3 } });
  assert.equal(runCli(["-a", "p", "hi"], { ...agy.env, STUB_OUTPUT: agyOut }).status, 0);
  const [a] = runs(agy.root);
  assert.deepEqual([a.model, a.model_source, a.tokens_in, a.tokens_out], ["m1", "requested", 10, 4]);

  const oc = scratchConfig(printConfig("opencode-events"));
  const ocOut = [
    { type: "text", part: { type: "text", text: "OK" } },
    { type: "step_finish", part: { type: "step-finish", tokens: { input: 30, output: 3, reasoning: 21 } } },
  ].map((x) => JSON.stringify(x)).join("\n");
  assert.equal(runCli(["-a", "p", "hi"], { ...oc.env, STUB_OUTPUT: ocOut }).status, 0);
  const [o] = runs(oc.root);
  assert.deepEqual([o.model_source, o.tokens_in, o.tokens_out], ["requested", 30, 24]);
});

test("text output records no token fields", () => {
  const s = scratchConfig(printConfig("text"));
  assert.equal(runCli(["-a", "p", "hi"], { ...s.env, STUB_OUTPUT: "OK" }).status, 0);
  const [row] = runs(s.root);
  assert.equal("tokens_in" in row, false);
  assert.equal(row.model_source, "requested");
});

test("a config-sourced empty catalog entry does not block -m on an agent without config models", () => {
  const s = scratchConfig(argvConfig({ models: undefined }));
  writeCatalog(s.root, {
    agents: { argv: { fetched_at: "2026-11-25T00:00:00.000Z", source: "config", models: [] } },
  });
  const result = runCli(["-a", "argv", "-m", "anything", "hello"], s.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "--model\nanything\nhello\n");
});

test("a model missing from the cached catalog refreshes that agent once before refusing", () => {
  const list = (models: string) => ({ cmd: [fixture("stub-models"), "models", models], parse: "lines-first-field" });
  const config = argvConfig({ models: undefined, list_models: list("m-small\nm-new\n") });
  const s = scratchConfig(config);
  writeCatalog(s.root, { agents: { argv: { fetched_at: "2026-11-24T00:00:00.000Z", source: "cli", models: [{ id: "m-small", status: "usable" }] } } });
  const ok = runCli(["-a", "argv", "-m", "m-new", "hello"], s.env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "--model\nm-new\nhello\n");
  assert.match(ok.stderr, /catalog refreshed for argv: m-new is usable/);
  const cached = JSON.parse(readFileSync(join(s.root, "cache", "multi-agent-router", "catalog.json"), "utf8"));
  assert.deepEqual(cached.agents.argv.models.map((m: { id: string }) => m.id).sort(), ["m-new", "m-small"]);
  const ghost = runCli(["-a", "argv", "-m", "m-ghost", "hello"], s.env);
  assert.equal(ghost.status, 2);
  assert.equal(ghost.stderr, "[ask-agent] model m-ghost is not usable for agent argv (not in catalog)\n");
});

test("a fallback agent that cannot run the requested model is skipped, not run", () => {
  const config = baseConfig() as AnyConfig;
  config.agents.f = { enabled: true, command: fixture("stub-fail"), timeout_seconds: 1, models: ["m1"], fallback: ["g"], args: ["{prompt}"], output: "text" };
  config.agents.g = { enabled: true, command: fixture("stub-argv"), timeout_seconds: 1, models: ["m2"], args: ["{model_args}", "{prompt}"], model_args: ["--model", "{model}"], output: "text" };
  const s = scratchConfig(config);
  const result = runCli(["-a", "f", "-m", "m1", "hello"], s.env);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /\[ask-agent\] skip g: model m1 is not usable \(not in agents\.g\.models\)\n/);
  assert.deepEqual(runs(s.root).map((row) => row.agent), ["f"]);
});

test("a model that needs usage credits fails that run without cooling the whole agent down", () => {
  const s = scratchConfig(printConfig("claude-json", "fable"));
  const out = JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 429,
    result: "Fable 5.2 requires usage credits. Switch to another model to continue." });
  const result = runCli(["-a", "p", "hello"], { ...s.env, STUB_OUTPUT: out });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\[ask-agent\] p cannot run model fable: Fable 5\.2 requires usage credits\. Switch to another model to continue\.\n/);
  assert.doesNotMatch(result.stderr, /cooled down/);
  assert.equal(existsSync(join(s.root, "cache", "multi-agent-router", "cooldown.json")), false);
});
