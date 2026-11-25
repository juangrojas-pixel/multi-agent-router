import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseConfig, fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

type AnyConfig = { agents: Record<string, Record<string, unknown>>; backend?: string; herdr_command?: string };

function herdrConfig(command = fixture("stub-argv"), timeout = 5): AnyConfig {
  const config = baseConfig() as AnyConfig;
  config.agents.argv = { enabled: true, command, timeout_seconds: timeout, model: "m1", args: ["{model_args}", "{prompt}"], model_args: ["--model", "{model}"], output: "text" };
  config.backend = "herdr";
  config.herdr_command = fixture("stub-herdr");
  return config;
}

function setup(config: AnyConfig, extra: NodeJS.ProcessEnv = {}) {
  const s = scratchConfig(config);
  const calls = join(s.root, "herdr-calls");
  return { ...s, calls, env: { ...s.env, HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_CALLS: calls, ...extra } };
}

function calls(path: string): string[][] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((line) => line.split("|"));
}

test("a run inside Herdr opens a labeled sibling pane, reports the agent and returns the subprocess result", () => {
  const s = setup(herdrConfig());
  const result = runCli(["-a", "argv", "--task", "T9", "hello world"], s.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "--model\nm1\nhello world\n");
  assert.match(result.stderr, /\[ask-agent\] running argv in herdr pane w1:p9\n/);
  const seen = calls(s.calls);
  const cwd = process.cwd();
  assert.deepEqual(seen[0], ["pane", "split", "--current", "--direction", "right", "--cwd", s.root.length ? seen[0][6] : cwd, "--no-focus"]);
  assert.deepEqual(seen[1], ["pane", "rename", "w1:p9", "argv T9"]);
  assert.deepEqual(seen[2], ["pane", "report-agent", "w1:p9", "--source", "ask-agent", "--agent", "argv", "--state", "working", "--message", "m1 T9"]);
  assert.equal(seen[3][0] + seen[3][1] + seen[3][2], "panerunw1:p9");
  const tail = seen.slice(4).map((c) => c.slice(0, 2).join(" "));
  assert.deepEqual(tail, ["pane release-agent", "pane close"]);
});

test("a failed run keeps the pane open and reports it idle with the failure", () => {
  const s = setup(herdrConfig(fixture("stub-fail")));
  const result = runCli(["-a", "argv", "hello"], s.env);
  assert.equal(result.status, 2);
  const seen = calls(s.calls);
  assert.ok(!seen.some((c) => c[0] === "pane" && c[1] === "close"), "pane stays open");
  const last = seen.at(-1)!;
  assert.deepEqual(last.slice(0, 9), ["pane", "report-agent", "w1:p9", "--source", "ask-agent", "--agent", "argv", "--state", "idle"]);
  assert.match(last.at(-1)!, /failed \(exit 1\)/);
});

test("a timeout interrupts the pane and returns the timeout result", () => {
  const s = setup(herdrConfig(fixture("stub-slow"), 1));
  const result = runCli(["-a", "argv", "hello"], s.env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /argv timed out after 1s/);
  assert.ok(calls(s.calls).some((c) => c[1] === "send-keys" && c[3] === "ctrl+c"));
});

test("outside Herdr the herdr backend falls back to a subprocess and says why", () => {
  const s = setup(herdrConfig(), { HERDR_ENV: "" });
  const result = runCli(["-a", "argv", "hello"], s.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "--model\nm1\nhello\n");
  assert.match(result.stderr, /herdr unavailable \(not inside a Herdr pane\), falling back to subprocess/);
  assert.deepEqual(calls(s.calls), []);
});

test("a refused split falls back to a subprocess", () => {
  const s = setup(herdrConfig(), { HERDR_FAIL_SPLIT: "1" });
  const result = runCli(["-a", "argv", "hello"], s.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /herdr unavailable \(.*no_space.*\), falling back to subprocess/);
});

test("--backend herdr is accepted on the command line", () => {
  const config = herdrConfig();
  delete config.backend;
  const s = setup(config);
  const result = runCli(["--backend", "herdr", "-a", "argv", "hello"], s.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /running argv in herdr pane w1:p9/);
});
