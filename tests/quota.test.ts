import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

const RESET = "2030-01-01T00:00:00Z";
const RESET_EPOCH = Date.parse(RESET) / 1000;

function setup(usage: object) {
  const scratch = scratchConfig({
    cooldown_seconds: 3600,
    default_tier: "execute",
    tiers: { execute: ["agy"] },
    agents: {
      agy: {
        enabled: true,
        command: fixture("stub-agy"),
        timeout_seconds: 5,
        extra_args: [],
        quota: { group: "Gemini Models", min_remaining: 0.1 },
      },
    },
  });
  const usageFile = join(scratch.root, "usage.json");
  writeFileSync(usageFile, JSON.stringify(usage));
  return { ...scratch, env: { ...scratch.env, STUB_USAGE: usageFile } };
}

function usage(group: string, fractions: number[]): object {
  return {
    command: {
      data: {
        groups: [{ name: group, buckets: fractions.map((f) => ({ remaining_fraction: f, reset_time: RESET })) }],
      },
    },
  };
}

test("agy below its quota threshold is skipped and cooled down until the bucket reset", () => {
  const scratch = setup(usage("Gemini Models", [0.8, 0.05]));
  const result = runCli(["-a", "agy", "hello"], scratch.env);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /skip agy: quota low \(5% < 10%\)/);
  const cooldown = JSON.parse(readFileSync(join(scratch.env.XDG_CACHE_HOME!, "multi-agent-router", "cooldown.json"), "utf8"));
  assert.equal(cooldown.agy, RESET_EPOCH);
});

test("agy above its quota threshold runs the task", () => {
  const scratch = setup(usage("Gemini Models", [0.8, 0.5]));
  const result = runCli(["-a", "agy", "hello"], scratch.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
  assert.equal(existsSync(join(scratch.env.XDG_CACHE_HOME!, "multi-agent-router", "cooldown.json")), false);
});

test("agy is skipped when its quota group is missing from the usage report", () => {
  const scratch = setup(usage("Other Models", [0.9]));
  const result = runCli(["-a", "agy", "hello"], scratch.env);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /skip agy: quota group not found/);
});
