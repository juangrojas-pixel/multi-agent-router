import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, pathWithoutJq, runCli, scratchConfig } from "./fixtures/helpers.ts";

const FUTURE = 4_102_444_800; // 2100-01-01T00:00:00Z

function bash(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync("bin/ask-agent", args, { encoding: "utf8", env });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function state(root: string): string { return join(root, "cache", "multi-agent-router"); }

function writeCooldowns(root: string, data: Record<string, number>): void {
  mkdirSync(state(root), { recursive: true });
  writeFileSync(join(state(root), "cooldown.json"), JSON.stringify(data));
}

function cooldowns(root: string): Record<string, number> {
  return JSON.parse(readFileSync(join(state(root), "cooldown.json"), "utf8"));
}

function statusConfig(usage: string) {
  const setup = scratchConfig({
    default_tier: "execute",
    tiers: { think: ["codex"], execute: ["agy", "codex"], draft: ["opencode"] },
    agents: {
      codex: { enabled: true, command: fixture("stub-ok"), args: ["{prompt}"], output: "text" },
      agy: { enabled: true, command: fixture("stub-agy"), quota: { group: "Gemini Models", min_remaining: 0.1 } },
      opencode: { enabled: false, command: "opencode" },
      "gentle-shell": { enabled: true, command: "/no/such/command" },
    },
  });
  const usagePath = join(setup.root, "usage.json");
  writeFileSync(usagePath, usage);
  return { ...setup, env: { ...setup.env, STUB_USAGE: usagePath } };
}

const USAGE = JSON.stringify({
  command: { data: { groups: [
    { name: "Gemini Models", buckets: [
      { window: "5h", remaining_fraction: 0.5, reset_time: "2030-01-01T00:00:00Z" },
      { window: "week", remaining_fraction: 0.873, reset_time: "2030-01-02T00:00:00Z" },
    ] },
    { name: "Other", buckets: [{ remaining_fraction: 1, reset_time: "x" }] },
  ] } },
});

const STATUS = [
  "codex         [think,execute]          ready",
  "agy           [execute]                ready",
  "opencode      [draft]                  skip: disabled",
  "gentle-shell  [explicit only]          skip: command not found: /no/such/command",
  "",
  "agy quota:",
  "  Gemini Models / 5h: 50% (reset 2030-01-01T00:00:00Z)",
  "  Gemini Models / week: 87% (reset 2030-01-02T00:00:00Z)",
  "  Other / null: 100% (reset x)",
  "",
].join("\n");

test("status, reset and runs run without the bash router", () => {
  const s = statusConfig(USAGE);
  const env = { ...s.env, PATH: pathWithoutJq() };
  const status = runCli(["status"], env);
  assert.equal(status.stderr, "");
  assert.equal(status.stdout, STATUS);
  assert.equal(status.status, 0);
  const reset = runCli(["reset"], env);
  assert.equal(reset.stderr, "[ask-agent] cooldown cleared for all agents\n");
  assert.equal(reset.status, 0);
  const runs = runCli(["runs"], env);
  assert.equal(runs.stderr, `[ask-agent] no runs recorded yet (${join(state(s.root), "runs.jsonl")})\n`);
  assert.equal(runs.status, 0);
});

test("status prints the same table as the bash router", () => {
  const s = statusConfig(USAGE);
  const result = runCli(["status"], s.env);
  assert.deepEqual(result, { stdout: STATUS, stderr: "", status: 0 });
  assert.deepEqual(bash(["status"], s.env), result);
});

test("status with an empty agy usage answer matches the bash router", () => {
  const s = statusConfig("");
  const result = runCli(["status"], s.env);
  assert.match(result.stdout, /^agy +\[execute\] +skip: quota group not found$/m);
  assert.match(result.stdout, /\nagy quota:\n$/);
  assert.deepEqual(bash(["status"], s.env), result);
});

test("status shows when a cooldown ends", () => {
  const s = statusConfig(USAGE);
  writeCooldowns(s.root, { codex: FUTURE });
  const time = new Date(FUTURE * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const result = runCli(["status"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, new RegExp(`^codex +\\[think,execute\\] +skip: cooldown until ${time}$`, "m"));
});

test("status refuses a nested call", () => {
  const s = statusConfig(USAGE);
  const result = runCli(["status"], { ...s.env, ASK_AGENT_DEPTH: "1" });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "[ask-agent] error: nested call refused: ask-agent is already running an agent\n");
  assert.equal(result.status, 2);
});

test("reset AGENT clears only that agent's cooldown", () => {
  const s = statusConfig(USAGE);
  writeCooldowns(s.root, { codex: FUTURE, agy: FUTURE });
  const result = runCli(["reset", "codex"], s.env);
  assert.deepEqual(result, { stdout: "", stderr: "[ask-agent] cooldown cleared codex\n", status: 0 });
  assert.deepEqual(cooldowns(s.root), { agy: FUTURE });
  writeCooldowns(s.root, { codex: FUTURE, agy: FUTURE });
  assert.deepEqual(bash(["reset", "codex"], s.env), result);
  assert.deepEqual(cooldowns(s.root), { agy: FUTURE });
});

test("reset without an agent clears every cooldown", () => {
  const s = statusConfig(USAGE);
  writeCooldowns(s.root, { codex: FUTURE, agy: FUTURE });
  const result = runCli(["reset"], s.env);
  assert.deepEqual(result, { stdout: "", stderr: "[ask-agent] cooldown cleared for all agents\n", status: 0 });
  assert.deepEqual(cooldowns(s.root), {});
  writeCooldowns(s.root, { codex: FUTURE });
  assert.deepEqual(bash(["reset"], s.env), result);
  assert.deepEqual(cooldowns(s.root), {});
});

function runsFixture() {
  const s = statusConfig(USAGE);
  mkdirSync(state(s.root), { recursive: true });
  const row = (ts: number, agent: string, prompt: string, extra: object = {}) =>
    JSON.stringify({ ts, agent, tier: "", model: "", cwd: "/work/dir", exit: 0, seconds: 3, prompt, changed_files: [], ...extra });
  const lines = [
    row(1_700_000_000, "codex", "first\ttask\n  with   spaces and a \\ backslash"),
    row(1_700_003_600, "agy", "x".repeat(100), { exit: 1, seconds: 12, changed_files: ["a", "b"] }),
    "{\"broken",
    row(1_700_007_200, "codex", "third"),
  ];
  writeFileSync(join(state(s.root), "runs.jsonl"), `${lines.join("\n")}\n`);
  return s;
}

const ROWS = [
  "2023-11-14 22:13\tcodex\texit=0\t3s\tfiles=0\t/work/dir\tfirst task with spaces and a \\\\ backslash",
  `2023-11-14 23:13\tagy\texit=1\t12s\tfiles=2\t/work/dir\t${"x".repeat(80)}`,
  "2023-11-15 00:13\tcodex\texit=0\t3s\tfiles=0\t/work/dir\tthird",
];

test("runs lists the history in UTC, skipping corrupt lines, like the bash router", () => {
  const s = runsFixture();
  const cases: Array<[string[], string]> = [
    [["runs"], `${ROWS.join("\n")}\n`],
    [["runs", "2"], `${ROWS.slice(1).join("\n")}\n`],
    [["runs", "-a", "codex"], `${ROWS[0]}\n${ROWS[2]}\n`],
    [["runs", "--agent", "codex", "1"], `${ROWS[2]}\n`],
  ];
  for (const [args, stdout] of cases) {
    const result = runCli(args, { ...s.env, TZ: "America/Bogota" });
    assert.deepEqual(result, { stdout, stderr: "", status: 0 }, args.join(" "));
    assert.deepEqual(bash(args, { ...s.env, TZ: "America/Bogota" }), result, args.join(" "));
  }
  // The bash router can exit 141 here (SIGPIPE from jq into `tail -n 0`); the TS router exits 0.
  assert.deepEqual(runCli(["runs", "0"], s.env), { stdout: "", stderr: "", status: 0 });
});

test("runs rejects bad arguments like the bash router", () => {
  const s = runsFixture();
  for (const args of [["runs", "x"], ["runs", ""], ["runs", "-a"], ["runs", "--agent", ""], ["runs", "-1"]]) {
    const result = runCli(args, s.env);
    assert.deepEqual(result, { stdout: "", stderr: "[ask-agent] error: usage: ask-agent runs [N] [-a AGENT]\n", status: 2 }, args.join(" "));
    assert.deepEqual(bash(args, s.env), result, args.join(" "));
  }
});

test("runs with no history says so", () => {
  const s = statusConfig(USAGE);
  const result = runCli(["runs"], s.env);
  assert.deepEqual(result, { stdout: "", stderr: `[ask-agent] no runs recorded yet (${join(state(s.root), "runs.jsonl")})\n`, status: 0 });
  assert.deepEqual(bash(["runs"], s.env), result);
});

test("reset, runs and parallel with a missing config keep the bash router's message", () => {
  const s = statusConfig(USAGE);
  const env = { ...s.env, ASK_AGENT_CONFIG: "/definitely/missing/agents.json" };
  for (const args of [["reset"], ["runs"], ["parallel", "PING"]]) {
    const result = runCli(args, env);
    assert.deepEqual(result, { stdout: "", stderr: "[ask-agent] error: config not found: /definitely/missing/agents.json\n", status: 2 });
    assert.deepEqual(bash(args, env), result);
  }
  assert.equal(existsSync(join(s.root, "cache", "multi-agent-router", "runs.jsonl")), false);
});
