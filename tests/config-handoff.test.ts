import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { baseConfig, runCli, scratchConfig } from "./fixtures/helpers.ts";

test("status with a missing config keeps the bash router's message", () => {
  const setup = scratchConfig(baseConfig());
  const env = { ...setup.env, ASK_AGENT_CONFIG: "/definitely/missing/agents.json" };
  const oldResult = spawnSync("bin/ask-agent", ["status"], { encoding: "utf8", env });
  const newResult = runCli(["status"], env);
  assert.equal(newResult.status, oldResult.status);
  assert.equal(newResult.stdout, oldResult.stdout);
  assert.equal(newResult.stderr, oldResult.stderr);
});
