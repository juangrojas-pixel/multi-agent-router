import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, pathWithoutJq, runCli, scratchConfig } from "./fixtures/helpers.ts";

function bash(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync("bin/ask-agent", args, { encoding: "utf8", env });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function agent(stub: string, extra: object = {}) {
  return { enabled: true, command: fixture(stub), timeout_seconds: 5, args: ["{prompt}"], output: "text", ...extra };
}

function setup(agents: Record<string, object>, tiers: Record<string, string[]> = { execute: Object.keys(agents) }) {
  return scratchConfig({ cooldown_seconds: 3600, default_tier: "execute", tiers, agents });
}

function runs(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "cache", "multi-agent-router", "runs.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
}

test("parallel prints one block per ready agent and replays each agent's stderr", () => {
  const s = setup({ one: agent("stub-ok"), two: agent("stub-fail") });
  const result = runCli(["parallel", "-a", "one,two", "PING"], { ...s.env, PATH: pathWithoutJq() });
  assert.equal(result.stdout, "### one\n\nPING\n\n### two\n\n_(no answer: two failed (exit 1):   )_\n\n");
  assert.equal(result.stderr, "[ask-agent] using one\n[ask-agent] using two\n[ask-agent] two failed (exit 1):   \n");
  assert.equal(result.status, 0);
  assert.deepEqual(runs(s.root).map((row) => [row.agent, row.exit]).sort(), [["one", 0], ["two", 1]]);
});

test("parallel runs every ready agent at once", () => {
  const s = setup({ one: agent("stub-sleep"), two: agent("stub-sleep"), three: agent("stub-sleep") });
  const started = Date.now();
  const result = runCli(["parallel", "-t", "execute", "PING"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "### one\n\nPING\n\n### two\n\nPING\n\n### three\n\nPING\n\n");
  assert.ok(Date.now() - started < 2_500, `took ${Date.now() - started} ms`);
  assert.deepEqual(runs(s.root).map((row) => row.tier), ["execute", "execute", "execute"]);
});

test("parallel skips agents that are not ready and fails when none is", () => {
  const s = setup({ one: agent("stub-ok", { enabled: false }), two: agent("stub-ok", { command: "/no/such/agent" }) });
  const result = runCli(["parallel", "PING"], s.env);
  assert.deepEqual(result, {
    stdout: "",
    stderr: [
      "[ask-agent] skip one: disabled",
      "[ask-agent] skip two: command not found: /no/such/agent",
      "[ask-agent] error: no agent ready (checked: one two)",
      "",
    ].join("\n"),
    status: 2,
  });
});

test("parallel exits 2 after the blocks when every agent fails", () => {
  const s = setup({ one: agent("stub-fail") });
  const result = runCli(["parallel", "PING"], s.env);
  assert.equal(result.stdout, "### one\n\n_(no answer: one failed (exit 1):   )_\n\n");
  assert.equal(result.stderr, "[ask-agent] using one\n[ask-agent] one failed (exit 1):   \n[ask-agent] error: no agent could answer\n");
  assert.equal(result.status, 2);
});

test("parallel rejects options and arguments like the bash router", () => {
  const s = scratchConfig({
    default_tier: "execute",
    tiers: { execute: ["codex"] },
    agents: { codex: agent("stub-ok"), "gentle-shell": agent("stub-ok") },
  });
  const cases = [
    ["parallel", "-r", "coder", "PING"],
    ["parallel", "-t", "execute", "-a", "codex", "PING"],
    ["parallel", "-a", "nope", "PING"],
    ["parallel", "-t", "nope", "PING"],
    ["parallel", "--backend", "nope", "PING"],
    ["parallel", "-a", "codex", "   "],
  ];
  for (const args of cases) {
    const result = runCli(args, s.env);
    assert.equal(result.status, 2, args.join(" "));
    assert.deepEqual(result, bash(args, s.env), args.join(" "));
  }
  // bash also prints its own `cd` error line, which names the script path; only the router line is kept.
  const cd = runCli(["parallel", "-a", "codex", "-C", "/no/such/dir", "PING"], s.env);
  assert.deepEqual(cd, { stdout: "", stderr: "[ask-agent] error: cannot cd to /no/such/dir\n", status: 2 });
});

test("parallel answers like the bash router, including failures", () => {
  const multi = fixture("stub-multi");
  const s = scratchConfig({
    default_tier: "execute",
    tiers: { execute: ["codex", "gentle-shell"] },
    agents: {
      codex: { enabled: true, command: fixture("stub-ok"), timeout_seconds: 5 },
      "gentle-shell": { enabled: true, command: multi, timeout_seconds: 5 },
    },
  });
  const result = runCli(["parallel", "PING"], s.env);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /_\(no answer: gentle-shell failed \(exit 3\): out1 out2 err1 err2 \)_/);
  assert.deepEqual(result, bash(["parallel", "PING"], s.env));
});

test("-a keeps the bash router's one-line failure message", () => {
  const s = scratchConfig({
    default_tier: "execute",
    tiers: { execute: ["codex"] },
    agents: { codex: { enabled: true, command: fixture("stub-multi"), timeout_seconds: 5 } },
  });
  const result = runCli(["-a", "codex", "PING"], s.env);
  assert.deepEqual(result, {
    stdout: "",
    stderr: [
      "[ask-agent] using codex",
      "[ask-agent] codex failed (exit 3): out1 out2 err1 err2 ",
      "[ask-agent] error: no agent could answer (tried: codex)",
      "",
    ].join("\n"),
    status: 2,
  });
  assert.deepEqual(bash(["-a", "codex", "PING"], s.env), result);
});

test("-a still answers through the first ready agent", () => {
  const s = setup({ one: agent("stub-ok") });
  assert.deepEqual(runCli(["-a", "one", "PING"], s.env), { stdout: "PING\n", stderr: "[ask-agent] using one\n", status: 0 });
});
