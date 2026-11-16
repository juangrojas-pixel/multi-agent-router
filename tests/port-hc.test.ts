import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

// Every test runs against tests/fixtures/stub-hc, never the real hc.
function agent(stub: string, extra: object = {}) {
  return { enabled: true, command: fixture(stub), timeout_seconds: 5, args: ["{prompt}"], output: "text", ...extra };
}

function setup(config: Record<string, unknown> = {}, agents: Record<string, object> = { one: agent("stub-ok") }) {
  const s = scratchConfig({
    cooldown_seconds: 3600,
    default_tier: "execute",
    tiers: { execute: Object.keys(agents) },
    hc_command: fixture("stub-hc"),
    agents,
    ...config,
  });
  const hcState = join(s.root, "hc-state");
  mkdirSync(hcState);
  const log = join(s.root, "hc.log");
  return { ...s, log, env: { ...s.env, STUB_HC_STATE: hcState, STUB_HC_LOG: log } };
}

function hcCalls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

function attachLine(agentId: string): RegExp {
  return new RegExp(`^\\[ask-agent\\] running in hc terminal t1: hc attach aa-${agentId}-\\d+\\n`, "m");
}

test("--backend hc runs the agent in an hc terminal and returns its answer", () => {
  const s = setup();
  const result = runCli(["--backend", "hc", "-a", "one", "PING"], s.env);
  assert.equal(result.stdout, "PING\n");
  assert.match(result.stderr, attachLine("one"));
  assert.equal(result.status, 0);
  const calls = hcCalls(s.log);
  assert.equal(calls[0], "run");
  assert.equal(calls.at(-1), "rm");
});

test("the default backend does not use hc", () => {
  const s = setup();
  assert.deepEqual(runCli(["-a", "one", "PING"], s.env), { stdout: "PING\n", stderr: "[ask-agent] using one\n", status: 0 });
  assert.deepEqual(hcCalls(s.log), []);
});

test("backend precedence: flag, then agents.ID.backend, then backend, then subprocess", () => {
  const cases: Array<[Record<string, unknown>, object, string[], boolean]> = [
    [{ backend: "hc" }, {}, [], true],
    [{}, { backend: "hc" }, [], true],
    [{ backend: "hc" }, { backend: "subprocess" }, [], false],
    [{ backend: "hc" }, {}, ["--backend", "subprocess"], false],
    [{}, { backend: "hc" }, ["--backend", "subprocess"], false],
    [{ backend: "subprocess" }, {}, ["--backend", "hc"], true],
  ];
  for (const [global, perAgent, flag, usesHc] of cases) {
    const s = setup(global, { one: agent("stub-ok", perAgent) });
    const result = runCli([...flag, "-a", "one", "PING"], s.env);
    const label = JSON.stringify([global, perAgent, flag]);
    assert.equal(result.stdout, "PING\n", label);
    assert.equal(result.status, 0, label);
    assert.equal(hcCalls(s.log).includes("run"), usesHc, label);
  }
});

test("a missing hc falls back to the subprocess backend", () => {
  const s = setup({ hc_command: "/no/such/hc" });
  const result = runCli(["--backend", "hc", "-a", "one", "PING"], s.env);
  assert.equal(result.stdout, "PING\n");
  assert.match(result.stderr, /^\[ask-agent\] hc unavailable \(.*\/no\/such\/hc.*\), falling back to subprocess$/m);
  assert.equal(result.status, 0);
});

test("an hc that cannot start the terminal falls back with its last line", () => {
  const s = setup();
  const result = runCli(["--backend", "hc", "-a", "one", "PING"], { ...s.env, STUB_HC_FAIL: "first\nserver not running" });
  assert.equal(result.stdout, "PING\n");
  assert.equal(result.stderr, "[ask-agent] using one\n[ask-agent] hc unavailable (server not running), falling back to subprocess\n");
  assert.equal(result.status, 0);
});

test("the agent's stderr and exit code survive hc: a quota error sets the cooldown", () => {
  const s = setup({}, { one: agent("stub-quota") });
  const before = Math.floor(Date.now() / 1000);
  const result = runCli(["--backend", "hc", "-a", "one", "PING"], s.env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[ask-agent\] one hit a quota\/rate limit: .*429 Too Many Requests/m);
  const cooldown = JSON.parse(readFileSync(join(s.root, "cache", "multi-agent-router", "cooldown.json"), "utf8"));
  assert.ok(cooldown.one >= before + 3600);
  const row = JSON.parse(readFileSync(join(s.root, "cache", "multi-agent-router", "runs.jsonl"), "utf8"));
  assert.equal(row.exit, 1);
});

test("the timeout kills and removes the hc terminal", () => {
  const slow = join(scratchConfig({}).root, "slow");
  writeFileSync(slow, "#!/usr/bin/env bash\nsleep 30\n", { mode: 0o755 });
  const s = setup({}, { one: { ...agent("stub-ok"), command: slow, timeout_seconds: 2 } });
  const started = Date.now();
  const result = runCli(["--backend", "hc", "-a", "one", "PING"], s.env);
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  assert.match(result.stderr, /^\[ask-agent\] one timed out after 2s$/m);
  assert.equal(result.status, 2);
  const calls = hcCalls(s.log);
  assert.ok(calls.includes("kill") && calls.at(-1) === "rm", calls.join(" "));
});

test("role and parallel runs use the hc backend too", () => {
  const s = setup({ roles: { coder: { description: "code", agents: ["one"] } } });
  const role = runCli(["--backend", "hc", "-r", "coder", "PING"], s.env);
  assert.equal(role.stdout, "PING\n");
  assert.match(role.stderr, attachLine("one"));
  assert.equal(role.status, 0);
  const parallel = runCli(["parallel", "--backend", "hc", "-a", "one", "PING"], s.env);
  assert.equal(parallel.stdout, "### one\n\nPING\n\n");
  assert.match(parallel.stderr, attachLine("one"));
  assert.equal(parallel.status, 0);
});

test("--backend rejects other values like the bash router", () => {
  const s = setup();
  assert.deepEqual(runCli(["--backend", "nope", "-a", "one", "PING"], s.env),
    { stdout: "", stderr: "[ask-agent] error: unknown backend: nope (use hc or subprocess)\n", status: 2 });
  assert.deepEqual(runCli(["--backend"], s.env),
    { stdout: "", stderr: "[ask-agent] error: unknown backend:  (use hc or subprocess)\n", status: 2 });
});
