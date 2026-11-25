import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

function setup(agents: Record<string, object>, configExtra: Record<string, unknown> = {}) {
  const s = scratchConfig({
    cooldown_seconds: 3600,
    default_tier: "execute",
    tiers: { execute: Object.keys(agents) },
    hc_command: fixture("stub-hc-live"),
    agents,
    ...configExtra,
  });
  const hcState = join(s.root, "hc-state");
  mkdirSync(hcState);
  const log = join(s.root, "hc.log");
  return {
    ...s,
    log,
    env: { ...s.env, STUB_HC_STATE: hcState, STUB_HC_LOG: log },
  };
}

function calls(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function runs(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "cache", "multi-agent-router", "runs.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function liveAgent(command: string, extra: object = {}) {
  return {
    enabled: true,
    command,
    timeout_seconds: 5,
    args: ["{prompt}"],
    output: "agy-json",
    live: {
      args: ["{model_args}"],
      model_args: ["--model", "{model}"],
      dialogs: [{ match: "Trust this folder?", keys: ["enter"] }],
    },
    ...extra,
  };
}

test("US8-AS1/2/3: live run resolves absolute path, answers configured dialog, sends task on idle, reads answer file and leaves terminal open", (t) => {
  const s = setup({ liveagent: liveAgent("fake-tui-cli") });
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  const binDir = join(s.root, "bin");
  mkdirSync(binDir);
  const absCli = join(binDir, "fake-tui-cli");
  writeFileSync(absCli, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const result = runCli(
    ["--backend", "live", "-a", "liveagent", "-m", "m-pro", "--task", "T8", "Build the widget please"],
    { ...s.env, PATH: `${binDir}:${s.env.PATH ?? ""}`, STUB_LIVE_SCRIPT: "blocked:Trust this folder?,idle,working,done" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ANSWER: Build the widget ple\n");
  assert.match(result.stderr, /^\[ask-agent\] running liveagent live in hc terminal liveagent-t8-\d+$/m);
  assert.match(result.stderr, /^\[ask-agent\] liveagent answered; its terminal liveagent-t8-\d+ stays open in the Herdr app$/m);

  const recorded = calls(s.log);
  const runCall = recorded.find((c) => c[0] === "run");
  assert.ok(runCall, "hc run was called");
  assert.ok(runCall.includes("--bg") && runCall.includes("--json") && runCall.includes("--no-notify"));
  assert.ok(!runCall.includes("--no-parent"), "terminal stays under caller");
  const name = runCall[runCall.indexOf("--name") + 1];
  assert.match(name, /^liveagent-t8-\d+$/);
  assert.ok(name.length <= 32);
  const sep = runCall.indexOf("--");
  assert.deepEqual(runCall.slice(sep + 1), [absCli, "--model", "m-pro"]);

  const keysCalls = recorded.filter((c) => c[0] === "keys");
  assert.deepEqual(keysCalls, [["keys", "t1", "enter"]]);

  const sendCalls = recorded.filter((c) => c[0] === "send");
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0][1], "t1");
  assert.match(sendCalls[0][2], /^Build the widget please\n\nWhen you finish, write your complete final answer to .+ and then reply with exactly: DONE$/);

  assert.ok(!recorded.some((c) => c[0] === "rm"), "live terminal is never removed");

  const [row] = runs(s.root);
  assert.equal(row.agent, "liveagent");
  assert.equal(row.model, "m-pro");
  assert.equal(row.requested_model, "m-pro");
  assert.equal(row.model_source, "requested");
  assert.equal(row.task_id, "T8");
  assert.equal(row.exit, 0);
  assert.equal(row.answer, "ANSWER: Build the widget ple");
});

test("US8-AS2: unknown blocked dialog stops with exit 2 naming the terminal and dialog, leaving it open", (t) => {
  const s = setup({ liveagent: liveAgent(fixture("stub-ok")) });
  t.after(() => rmSync(s.root, { recursive: true, force: true }));

  const result = runCli(
    ["--backend", "live", "-a", "liveagent", "Do work"],
    { ...s.env, STUB_LIVE_SCRIPT: "blocked:Allow deleting files?" },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\[ask-agent\] liveagent is waiting for you in hc terminal liveagent-\d+: Allow deleting files\?$/m);

  const recorded = calls(s.log);
  assert.ok(!recorded.some((c) => c[0] === "keys"), "must not answer unknown dialog");
  assert.ok(!recorded.some((c) => c[0] === "send"), "must not send task while blocked");
  assert.ok(!recorded.some((c) => c[0] === "rm"), "terminal stays open");

  const [row] = runs(s.root);
  assert.equal(row.exit, 2);
});

test("configured dialog is answered at most 3 times before stopping with exit 2", (t) => {
  const s = setup({ liveagent: liveAgent(fixture("stub-ok")) });
  t.after(() => rmSync(s.root, { recursive: true, force: true }));

  const result = runCli(
    ["--backend", "live", "-a", "liveagent", "Do work"],
    {
      ...s.env,
      STUB_LIVE_SCRIPT: "blocked:Trust this folder?,blocked:Trust this folder?,blocked:Trust this folder?,blocked:Trust this folder?",
    },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[ask-agent\] liveagent is waiting for you in hc terminal liveagent-\d+: Trust this folder\?$/m);
  const recorded = calls(s.log);
  assert.equal(recorded.filter((c) => c[0] === "keys").length, 3);
  assert.ok(!recorded.some((c) => c[0] === "rm"));
});

test("idle after send with missing answer file falls back to last status.msg and notes it on stderr", (t) => {
  const s = setup({ liveagent: liveAgent(fixture("stub-ok")) });
  t.after(() => rmSync(s.root, { recursive: true, force: true }));

  const result = runCli(
    ["--backend", "live", "-a", "liveagent", "Do work"],
    { ...s.env, STUB_LIVE_SCRIPT: "idle,working,idle:Last reply from TUI", STUB_LIVE_NO_ANSWER: "1" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Last reply from TUI\n");
  assert.match(result.stderr, /answer file/i);
  assert.match(result.stderr, /stays open in the Herdr app/);
  assert.ok(!calls(s.log).some((c) => c[0] === "rm"));
});

test("error status returns exit 1 for the run with its message and keeps the terminal open", (t) => {
  const s = setup({ liveagent: liveAgent(fixture("stub-ok")) });
  t.after(() => rmSync(s.root, { recursive: true, force: true }));

  const result = runCli(
    ["--backend", "live", "-a", "liveagent", "Do work"],
    { ...s.env, STUB_LIVE_SCRIPT: "idle,error:Session crashed" },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Session crashed/);
  assert.ok(!calls(s.log).some((c) => c[0] === "rm"));

  const [row] = runs(s.root);
  assert.equal(row.exit, 1);
});

test("timeout interrupts or kills the live terminal and records status 142 without removing it", (t) => {
  const s = setup({ liveagent: liveAgent(fixture("stub-ok"), { timeout_seconds: 1 }) });
  t.after(() => rmSync(s.root, { recursive: true, force: true }));

  const started = Date.now();
  const result = runCli(
    ["--backend", "live", "-a", "liveagent", "Do work"],
    { ...s.env, STUB_LIVE_SCRIPT: "working" },
  );

  assert.ok(Date.now() - started < 6_000, `took ${Date.now() - started} ms`);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[ask-agent\] liveagent timed out after 1s$/m);

  const recorded = calls(s.log);
  assert.ok(recorded.some((c) => c[0] === "interrupt" || c[0] === "kill"), "must interrupt or kill on timeout");
  assert.ok(!recorded.some((c) => c[0] === "rm"), "never rm a live terminal");

  const [row] = runs(s.root);
  assert.equal(row.exit, 142);
});

test("US8-AS4: agent without live config falls back to the hc backend and says so", (t) => {
  const s = setup({
    plain: { enabled: true, command: fixture("stub-ok"), timeout_seconds: 5, args: ["{prompt}"], output: "text" },
  });
  t.after(() => rmSync(s.root, { recursive: true, force: true }));

  const result = runCli(["--backend", "live", "-a", "plain", "PING"], s.env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "PING\n");
  assert.match(result.stderr, /^\[ask-agent\] plain has no live config, using hc$/m);
  assert.match(result.stderr, /^\[ask-agent\] running in hc terminal t1: hc attach plain-\d+$/m);
  const recorded = calls(s.log);
  assert.equal(recorded[0][0], "run");
  assert.equal(recorded.at(-1)?.[0], "rm");
});

test("when hc cannot start a live terminal, it falls back to subprocess", (t) => {
  const s = setup({
    liveagent: liveAgent(fixture("stub-ok"), { output: "text" }),
  });
  t.after(() => rmSync(s.root, { recursive: true, force: true }));

  const result = runCli(
    ["--backend", "live", "-a", "liveagent", "PING"],
    { ...s.env, STUB_HC_FAIL: "hc server down" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "PING\n");
  assert.match(result.stderr, /^\[ask-agent\] hc unavailable \(hc server down\), falling back to subprocess$/m);
});
