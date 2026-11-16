import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

const FUTURE = Date.parse("2030-01-01T00:00:00Z") / 1000;

function agent(stub: string, extra: object = {}): object {
  return { enabled: true, command: fixture(stub), timeout_seconds: 1, extra_args: [], args: ["{prompt}"], output: "text", ...extra };
}

function setup(agents: Record<string, object>, roleAgents: string[]) {
  const scratch = scratchConfig({
    cooldown_seconds: 3600,
    default_tier: "execute",
    tiers: { execute: Object.keys(agents) },
    agents,
    roles: { coder: { description: "writes code", agents: roleAgents } },
  });
  return { ...scratch, env: { ...scratch.env, TZ: "UTC" } };
}

function stateDir(root: string): string { return join(root, "cache", "multi-agent-router"); }

function runs(root: string): Array<Record<string, unknown>> {
  const path = join(stateDir(root), "runs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function cooldowns(root: string): Record<string, number> {
  const path = join(stateDir(root), "cooldown.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

test("an entry in cooldown is skipped and the next one answers", () => {
  const s = setup({ first: agent("stub-ok"), second: agent("stub-ok") }, ["first", "second"]);
  mkdirSync(stateDir(s.root), { recursive: true });
  writeFileSync(join(stateDir(s.root), "cooldown.json"), JSON.stringify({ first: FUTURE }));
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
  assert.equal(result.stderr, [
    "[ask-agent] role coder: first failed (cooldown until 00:00), trying second",
    "[ask-agent] using second",
    "",
  ].join("\n"));
  assert.deepEqual(runs(s.root).map((row) => [row.role, row.agent, row.exit]), [["coder", "second", 0]]);
});

test("a quota error mid-run sets the cooldown and the next entry answers", () => {
  const s = setup({ first: agent("stub-quota"), second: agent("stub-ok") }, ["first", "second"]);
  const before = Math.floor(Date.now() / 1000);
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
  assert.equal(result.stderr, [
    "[ask-agent] using first",
    "[ask-agent] role coder: first failed (quota), trying second",
    "[ask-agent] using second",
    "",
  ].join("\n"));
  assert.ok(cooldowns(s.root).first >= before + 3600);
  assert.deepEqual(runs(s.root).map((row) => [row.role, row.agent, row.exit]), [["coder", "first", 1], ["coder", "second", 0]]);
});

test("a failing entry falls through to the next one", () => {
  const s = setup({ first: agent("stub-fail"), second: agent("stub-ok") }, ["first", "second"]);
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
  assert.match(result.stderr, /^\[ask-agent\] role coder: first failed \(exit 1\), trying second$/m);
  assert.deepEqual(cooldowns(s.root), {});
});

test("a timed-out entry falls through to the next one", () => {
  const s = setup({ first: agent("stub-slow"), second: agent("stub-ok") }, ["first", "second"]);
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
  assert.match(result.stderr, /^\[ask-agent\] role coder: first failed \(timeout\), trying second$/m);
});

test("an empty answer falls through to the next one", () => {
  const s = setup({ first: agent("stub-slow", { timeout_seconds: 5 }), second: agent("stub-ok") }, ["first", "second"]);
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
  assert.match(result.stderr, /^\[ask-agent\] role coder: first failed \(empty answer\), trying second$/m);
});

test("every entry unavailable exits 2 naming each reason and the role", () => {
  const s = setup({
    off: agent("stub-ok", { enabled: false }),
    missing: { ...agent("stub-ok"), command: "/definitely/missing/agent" },
    broken: agent("stub-fail"),
  }, ["off", "missing", "broken"]);
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, [
    "[ask-agent] role coder: off failed (disabled), trying missing",
    "[ask-agent] role coder: missing failed (not installed), trying broken",
    "[ask-agent] using broken",
    "[ask-agent] role coder: broken failed (exit 1)",
    "[ask-agent] role coder: no agent could run",
    "",
  ].join("\n"));
  assert.deepEqual(runs(s.root).map((row) => [row.role, row.agent, row.exit]), [["coder", "broken", 1]]);
});

test("a per-agent fallback list is not used for role runs", () => {
  const s = setup({ first: agent("stub-fail", { fallback: ["other"] }), other: agent("stub-ok") }, ["first"]);
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.deepEqual(runs(s.root).map((row) => row.agent), ["first"]);
});

test("-a still follows the per-agent fallback list", () => {
  const s = setup({ first: agent("stub-fail", { fallback: ["other"] }), other: agent("stub-ok") }, ["first"]);
  const result = runCli(["-a", "first", "hello"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
});
