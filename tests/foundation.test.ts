import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { baseConfig, runCli, scratchConfig } from "./fixtures/helpers.ts";

test("default ask by agent returns the stub answer", () => {
  const setup = scratchConfig(baseConfig());
  const result = runCli(["-a", "one", "hello"], setup.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
  assert.equal(result.stderr, "[ask-agent] using one\n");
});

test("default ask by tier returns the stub answer", () => {
  const setup = scratchConfig(baseConfig());
  const result = runCli(["-t", "execute", "hello"], setup.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
  assert.equal(result.stderr, "[ask-agent] using one\n");
});

test("tier and agent together exit 2", () => {
  const setup = scratchConfig(baseConfig());
  const result = runCli(["-t", "execute", "-a", "one", "hello"], setup.env);
  assert.equal(result.status, 2);
});

test("missing config exits 2", () => {
  const setup = scratchConfig(baseConfig());
  const result = runCli(["-a", "one", "hello"], { ...setup.env, ASK_AGENT_CONFIG: "/definitely/missing/agents.json" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[ask-agent\] config: \/definitely\/missing\/agents.json:/);
});

test("nested calls exit 2", () => {
  const setup = scratchConfig(baseConfig());
  const result = runCli(["-a", "one", "hello"], { ...setup.env, ASK_AGENT_DEPTH: "1" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /nested call refused/);
});

test("unported status matches the bash router", () => {
  const setup = scratchConfig(baseConfig());
  const oldResult = spawnSync("bin/ask-agent", ["status"], { encoding: "utf8", env: setup.env });
  const newResult = runCli(["status"], setup.env);
  assert.equal(newResult.status, oldResult.status);
  assert.equal(newResult.stdout, oldResult.stdout);
  assert.equal(newResult.stderr, oldResult.stderr);
});
