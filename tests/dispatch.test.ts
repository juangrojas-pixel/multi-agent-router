import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

const binPath = resolve(import.meta.dirname, "..", "bin", "ask-agent-ts");
const stubDispatch = fixture("stub-dispatch");
const stubOk = fixture("stub-ok");
const stubFail = fixture("stub-fail");

function runWithInput(args: string[], env: NodeJS.ProcessEnv, input?: string) {
  const result = spawnSync(binPath, args, { encoding: "utf8", env, input });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function writeBatch(dir: string, content: unknown, name = "batch.json"): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}

function readRuns(root: string): Array<Record<string, unknown>> {
  const file = join(root, "cache", "multi-agent-router", "runs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function writeCatalog(root: string, catalog: object): void {
  const cacheDir = join(root, "cache", "multi-agent-router");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, "catalog.json"), JSON.stringify(catalog, null, 2));
}

function writePolicy(root: string, policy: object): string {
  const policyDir = join(root, "config", "multi-agent-router");
  mkdirSync(policyDir, { recursive: true });
  const path = join(policyDir, "policy.json");
  writeFileSync(path, JSON.stringify(policy, null, 2));
  return path;
}

function setup(
  t: TestContext,
  overrides: Record<string, unknown> = {},
  options: { catalog?: object; policy?: object } = {},
) {
  const config = {
    cooldown_seconds: 3600,
    default_tier: "execute",
    dispatch: { concurrency: 3 },
    tiers: { execute: ["alpha", "beta", "gamma"] },
    agents: {
      alpha: {
        enabled: true, command: stubDispatch, timeout_seconds: 15,
        args: ["{model_args}", "{prompt}"], model_args: ["--model", "{model}"],
        models: ["m-good", "m-alt"], output: "text",
      },
      beta: {
        enabled: true, command: stubDispatch, timeout_seconds: 15,
        args: ["{model_args}", "{prompt}"], model_args: ["--model", "{model}"],
        output: "text",
      },
      gamma: {
        enabled: true, command: stubDispatch, timeout_seconds: 15,
        args: ["{prompt}"], output: "text",
      },
      flaky: {
        enabled: true, command: stubFail, timeout_seconds: 15,
        args: ["{prompt}"], output: "text", fallback: ["backup"],
      },
      backup: {
        enabled: true, command: stubOk, timeout_seconds: 15,
        args: ["{prompt}"], output: "text",
      },
    },
    roles: {
      coder: { description: "Code tasks", agents: ["flaky", "backup"] },
      safe: { description: "Allowed client role", agents: ["alpha", "beta"] },
      mixed: { description: "Mixed client role", agents: ["alpha", "gamma"] },
    },
    ...overrides,
  };
  const s = scratchConfig(config);
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  if (options.catalog) writeCatalog(s.root, options.catalog);
  if (options.policy) writePolicy(s.root, options.policy);
  return s;
}

test("dispatch rejects invalid JSON, missing fields, unknown agent/role, bad model, duplicate ids, overlapping writes, and client violations before starting any child", (t) => {
  const s = setup(t, {}, {
    catalog: {
      agents: {
        alpha: {
          fetched_at: "2026-11-25T10:00:00.000Z",
          source: "cli",
          models: [
            { id: "m-good", status: "usable" },
            { id: "m-unavail", status: "unavailable" },
            { id: "m-ooq", status: "out_of_quota" },
          ],
        },
      },
    },
  });
  const marker = join(s.root, "marker.log");
  const env = { ...s.env, STUB_MARKER: marker };
  const work = s.root;

  // Invalid JSON
  const badJson = writeBatch(s.root, "{ not json", "bad.json");
  let res = runCli(["dispatch", "-f", badJson], env);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /\[ask-agent\] dispatch:/);

  // Missing file
  res = runCli(["dispatch", "-f", join(s.root, "missing.json")], env);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /missing\.json/);

  // Empty tasks
  res = runCli(["dispatch", "-f", writeBatch(s.root, { tasks: [] }, "empty.json")], env);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /tasks/);

  // Missing required fields (id, cwd, prompt, neither agent nor role, both agent and role)
  const cases: Array<[string, object, RegExp]> = [
    ["missing-id", { tasks: [{ agent: "alpha", cwd: work, prompt: "hi" }] }, /tasks\[0\]\.id/],
    ["missing-cwd", { tasks: [{ id: "t1", agent: "alpha", prompt: "hi" }] }, /tasks\[0\]\.cwd/],
    ["missing-prompt", { tasks: [{ id: "t1", agent: "alpha", cwd: work }] }, /tasks\[0\]\.prompt/],
    ["no-agent-or-role", { tasks: [{ id: "t1", cwd: work, prompt: "hi" }] }, /tasks\[0\].*agent.*role/],
    ["both-agent-and-role", { tasks: [{ id: "t1", agent: "alpha", role: "coder", cwd: work, prompt: "hi" }] }, /tasks\[0\].*agent.*role/],
    ["role-with-model", { tasks: [{ id: "t1", role: "coder", model: "m-good", cwd: work, prompt: "hi" }] }, /tasks\[0\]\.model/],
    ["unknown-agent", { tasks: [{ id: "t1", agent: "ghost", cwd: work, prompt: "hi" }] }, /tasks\[0\]\.agent.*ghost/],
    ["unknown-role", { tasks: [{ id: "t1", role: "ghost-role", cwd: work, prompt: "hi" }] }, /tasks\[0\]\.role.*ghost-role/],
    ["model-unavailable", {
      tasks: [
        { id: "t1", agent: "beta", cwd: work, prompt: "ok" },
        { id: "t2", agent: "alpha", model: "m-unavail", cwd: work, prompt: "hi" },
      ],
    }, /\[ask-agent\] dispatch: tasks\[1\]\.model: model m-unavail is not usable for agent alpha \(unavailable\)/],
    ["model-ooq", {
      tasks: [{ id: "t1", agent: "alpha", model: "m-ooq", cwd: work, prompt: "hi" }],
    }, /tasks\[0\]\.model: model m-ooq is not usable for agent alpha \(out_of_quota\)/],
    ["model-not-in-catalog", {
      tasks: [{ id: "t1", agent: "alpha", model: "m-missing", cwd: work, prompt: "hi" }],
    }, /tasks\[0\]\.model: model m-missing is not usable for agent alpha \(not in catalog\)/],
    ["duplicate-id", {
      tasks: [
        { id: "dup", agent: "alpha", cwd: work, prompt: "a" },
        { id: "dup", agent: "beta", cwd: work, prompt: "b" },
      ],
    }, /tasks\[1\]\.id.*dup/],
    ["overlap-same-resolved", {
      tasks: [
        { id: "t1", agent: "alpha", cwd: work, writes: ["src/a"], prompt: "a" },
        { id: "t2", agent: "beta", cwd: join(work, "src"), writes: ["a"], prompt: "b" },
      ],
    }, /tasks\[1\]\.writes/],
    ["overlap-prefix", {
      tasks: [
        { id: "t1", agent: "alpha", cwd: work, writes: ["src"], prompt: "a" },
        { id: "t2", agent: "beta", cwd: work, writes: ["src/sub/file.ts"], prompt: "b" },
      ],
    }, /tasks\[1\]\.writes/],
    ["client-without-policy", {
      tasks: [{ id: "t1", agent: "alpha", cwd: work, prompt: "a", client: true }],
    }, /tasks\[0\]\.client.*alpha/],
  ];

  for (const [name, batch, pattern] of cases) {
    const file = writeBatch(s.root, batch, `${name}.json`);
    const r = runCli(["dispatch", "-f", file], env);
    assert.equal(r.status, 2, `${name}: expected exit 2, got ${r.status} (stderr: ${r.stderr})`);
    assert.match(r.stderr, pattern, `${name}: stderr did not match`);
  }

  // No child started during any failed validation
  assert.equal(existsSync(marker), false, "no stub should have executed");
  assert.deepEqual(readRuns(s.root), [], "runs.jsonl should remain empty");
});

test("dispatch allows non-overlapping sibling write paths like src and src2", (t) => {
  const s = setup(t);
  const file = writeBatch(s.root, {
    tasks: [
      { id: "t1", agent: "alpha", cwd: s.root, writes: ["src"], prompt: "ONE" },
      { id: "t2", agent: "beta", cwd: s.root, writes: ["src2"], prompt: "TWO" },
    ],
  });
  const res = runCli(["dispatch", "-f", file], s.env);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /### t1 \(alpha\/default\)\n\nONE\n\n### t2 \(beta\/default\)\n\nTWO\n\n/);
});

test("dispatch enforces client_agents policy for agent and role tasks (FR-018)", (t) => {
  const s = setup(t, {}, { policy: { client_agents: ["alpha", "beta"] } });
  const marker = join(s.root, "marker.log");
  const env = { ...s.env, STUB_MARKER: marker };

  // Disallowed agent rejected before start
  const badAgent = writeBatch(s.root, {
    tasks: [
      { id: "t1", agent: "alpha", cwd: s.root, prompt: "OK", client: true },
      { id: "t2", agent: "gamma", cwd: s.root, prompt: "NO", client: true },
    ],
  }, "bad-agent.json");
  let res = runCli(["dispatch", "-f", badAgent], env);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /tasks\[1\]\.client.*gamma/);
  assert.equal(existsSync(marker), false);

  // Role containing any disallowed agent rejected before start
  const badRole = writeBatch(s.root, {
    tasks: [{ id: "t1", role: "mixed", cwd: s.root, prompt: "NO", client: true }],
  }, "bad-role.json");
  res = runCli(["dispatch", "-f", badRole], env);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /tasks\[0\]\.client.*gamma/);
  assert.equal(existsSync(marker), false);

  // Allowed agent and role with all allowed agents succeed
  const okBatch = writeBatch(s.root, {
    tasks: [
      { id: "t1", agent: "alpha", cwd: s.root, prompt: "CLIENT_AGENT", client: true },
      { id: "t2", role: "safe", cwd: s.root, prompt: "CLIENT_ROLE", client: true },
    ],
  }, "ok-client.json");
  res = runCli(["dispatch", "-f", okBatch], env);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /CLIENT_AGENT/);
  assert.match(res.stdout, /CLIENT_ROLE/);
});

test("dispatch respects concurrency limit and queues excess tasks without dropping any", (t) => {
  const s = setup(t, { dispatch: { concurrency: 2 } });
  const marker = join(s.root, "marker.log");
  const file = writeBatch(s.root, {
    tasks: [
      { id: "t1", agent: "alpha", cwd: s.root, prompt: "TASK1" },
      { id: "t2", agent: "beta", cwd: s.root, prompt: "TASK2" },
      { id: "t3", agent: "gamma", cwd: s.root, prompt: "TASK3" },
      { id: "t4", agent: "alpha", cwd: s.root, prompt: "TASK4" },
    ],
  });
  const res = runCli(["dispatch", "-f", file], { ...s.env, STUB_SLEEP: "0.4", STUB_MARKER: marker });
  assert.equal(res.status, 0, res.stderr);

  const events = readFileSync(marker, "utf8").trim().split("\n").map((line) => {
    const [kind, ts, prompt] = line.split(" ");
    return { kind, ts: Number(ts), prompt };
  });
  const starts = new Map(events.filter((e) => e.kind === "start").map((e) => [e.prompt, e.ts]));
  const ends = new Map(events.filter((e) => e.kind === "end").map((e) => [e.prompt, e.ts]));

  assert.equal(starts.size, 4, "all 4 tasks must have started");
  assert.equal(ends.size, 4, "all 4 tasks must have finished");
  const firstEnd = Math.min(ends.get("TASK1")!, ends.get("TASK2")!);
  assert.ok(starts.get("TASK3")! >= firstEnd, `TASK3 started (${starts.get("TASK3")}) before first task ended (${firstEnd})`);

  // Verify receipts exist for all 4 in order
  const order = [...res.stdout.matchAll(/^### (t\d+) /gm)].map((m) => m[1]);
  assert.deepEqual(order, ["t1", "t2", "t3", "t4"]);
});

test("dispatch runs 3 tasks of 2s concurrently under 4s total", (t) => {
  const s = setup(t, { dispatch: { concurrency: 3 } });
  const file = writeBatch(s.root, {
    tasks: [
      { id: "t1", agent: "alpha", cwd: s.root, prompt: "P1" },
      { id: "t2", agent: "beta", cwd: s.root, prompt: "P2" },
      { id: "t3", agent: "gamma", cwd: s.root, prompt: "P3" },
    ],
  });
  const started = Date.now();
  const res = runCli(["dispatch", "-f", file], { ...s.env, STUB_SLEEP: "2" });
  const elapsed = Date.now() - started;
  assert.equal(res.status, 0, res.stderr);
  assert.ok(elapsed < 4_000, `expected < 4000ms, took ${elapsed}ms`);
  assert.ok(elapsed >= 1_800, `expected stub sleep ~2000ms, took ${elapsed}ms`);
  assert.match(res.stdout, /### t1 \(alpha\/default\)\n\nP1\n\n### t2 \(beta\/default\)\n\nP2\n\n### t3 \(gamma\/default\)\n\nP3\n\n/);
});

test("dispatch exits 5 when some tasks fail while returning receipts for others in task order", (t) => {
  const s = setup(t);
  const file = writeBatch(s.root, {
    tasks: [
      { id: "t1", agent: "alpha", model: "m-good", cwd: s.root, prompt: "FIRST" },
      { id: "t2", agent: "beta", cwd: s.root, prompt: "PLEASE FAIL HERE" },
      { id: "t3", agent: "gamma", cwd: s.root, prompt: "THIRD" },
    ],
  });
  const res = runCli(["dispatch", "-f", file], s.env);
  assert.equal(res.status, 5);
  const blocks = res.stdout.split(/(?=^### )/m);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0], "### t1 (alpha/m-good)\n\nFIRST\n\n");
  assert.match(blocks[1], /^### t2 \(beta\/default\)\n\n_\(no answer: [^[\n]+\)_\n\n$/);
  assert.equal(blocks[2], "### t3 (gamma/default)\n\nTHIRD\n\n");

  // stderr replayed in task order (t1 alpha, t2 beta, t3 gamma)
  const idx1 = res.stderr.indexOf("[ask-agent] using alpha");
  const idx2 = res.stderr.indexOf("[ask-agent] using beta");
  const idx3 = res.stderr.indexOf("[ask-agent] using gamma");
  assert.ok(idx1 >= 0 && idx2 > idx1 && idx3 > idx2, `stderr out of order: ${res.stderr}`);
});

test("dispatch supports role fallback and agent fallback: true vs default no fallback", (t) => {
  const s = setup(t);

  // Role task falls back from flaky -> backup
  const roleFile = writeBatch(s.root, {
    batch_id: "b-role-test",
    tasks: [{ id: "r1", role: "coder", cwd: s.root, prompt: "ROLE_OK", reason: "role check" }],
  }, "role.json");
  let res = runCli(["dispatch", "-f", roleFile], s.env);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "### r1 (coder/default)\n\nROLE_OK\n\n");
  assert.match(res.stderr, /role coder: flaky failed.*trying backup/);

  // Agent task WITHOUT fallback: true does NOT fall back
  const noFbFile = writeBatch(s.root, {
    batch_id: "b-nofb",
    tasks: [{ id: "a1", agent: "flaky", cwd: s.root, prompt: "NO_FB" }],
  }, "nofb.json");
  res = runCli(["dispatch", "-f", noFbFile], s.env);
  assert.equal(res.status, 5);
  assert.doesNotMatch(res.stderr, /using backup/);
  const noFbRuns = readRuns(s.root).filter((r) => r.batch_id === "b-nofb");
  assert.deepEqual(noFbRuns.map((r) => r.agent), ["flaky"]);

  // Agent task WITH fallback: true falls back using agent's config fallback list
  const fbFile = writeBatch(s.root, {
    batch_id: "b-fb",
    tasks: [{ id: "a2", agent: "flaky", cwd: s.root, prompt: "WITH_FB", fallback: true }],
  }, "fb.json");
  res = runCli(["dispatch", "-f", fbFile], s.env);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "### a2 (flaky/default)\n\nWITH_FB\n\n");
  const fbRuns = readRuns(s.root).filter((r) => r.batch_id === "b-fb");
  assert.deepEqual(fbRuns.map((r) => [r.agent, r.exit, r.task_id]), [
    ["flaky", 1, "a2"],
    ["backup", 0, "a2"],
  ]);
});

test("dispatch --json, stdin (-), and runs.jsonl record task_id, reason and shared batch_id", (t) => {
  const s = setup(t);
  const batch = {
    tasks: [
      { id: "t-a", agent: "alpha", model: "m-good", cwd: s.root, prompt: "ANS_A", reason: "cheapest" },
      { id: "t-b", role: "coder", cwd: s.root, prompt: "ANS_B", reason: "role fallback" },
      { id: "t-c", agent: "beta", cwd: s.root, prompt: "WILL FAIL", reason: "failure case" },
    ],
  };
  const res = runWithInput(["dispatch", "-", "--json"], s.env, JSON.stringify(batch));
  assert.equal(res.status, 5);
  const receipts = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
  assert.equal(receipts.length, 3);
  assert.deepEqual(
    receipts.map(({ task_id, agent, role, model, exit, answer }) => ({ task_id, agent, role, model, exit, answer })),
    [
      { task_id: "t-a", agent: "alpha", role: null, model: "m-good", exit: 0, answer: "ANS_A" },
      { task_id: "t-b", agent: null, role: "coder", model: null, exit: 0, answer: "ANS_B" },
      { task_id: "t-c", agent: "beta", role: null, model: null, exit: 2, answer: "" },
    ],
  );
  for (const r of receipts) {
    assert.equal(typeof r.seconds, "number");
  }

  const rows = readRuns(s.root);
  assert.equal(rows.length, 4, "t-a (1) + t-b (flaky + backup = 2) + t-c (1) = 4 runs");
  const batchIds = new Set(rows.map((r) => r.batch_id));
  assert.equal(batchIds.size, 1, "all runs share one generated batch_id");
  const [generatedId] = [...batchIds];
  assert.match(String(generatedId), /^b-\d+-\d+$/);

  const byTask = (id: string) => rows.filter((r) => r.task_id === id);
  assert.equal(byTask("t-a")[0].reason, "cheapest");
  assert.equal(byTask("t-b").every((r) => r.reason === "role fallback"), true);
  assert.equal(byTask("t-c")[0].reason, "failure case");
});

test("dispatch preserves task order even when earlier tasks finish slower than later tasks", (t) => {
  const s = setup(t, {
    dispatch: { concurrency: 3 },
    roles: {},
    agents: {
      slow: { enabled: true, command: stubDispatch, timeout_seconds: 15, args: ["{prompt}"], output: "text" },
      fast: { enabled: true, command: stubOk, timeout_seconds: 15, args: ["{prompt}"], output: "text" },
    },
  });
  const file = writeBatch(s.root, {
    tasks: [
      { id: "slow-1", agent: "slow", cwd: s.root, prompt: "SLOW_FIRST" },
      { id: "fast-2", agent: "fast", cwd: s.root, prompt: "FAST_SECOND" },
    ],
  });
  const res = runCli(["dispatch", "-f", file], { ...s.env, STUB_SLEEP: "0.5" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "### slow-1 (slow/default)\n\nSLOW_FIRST\n\n### fast-2 (fast/default)\n\nFAST_SECOND\n\n");
  const idxSlow = res.stderr.indexOf("[ask-agent] using slow");
  const idxFast = res.stderr.indexOf("[ask-agent] using fast");
  assert.ok(idxSlow >= 0 && idxFast > idxSlow, `stderr must replay in task order: ${res.stderr}`);
});

test("dispatch validates model against config models when no catalog exists and accepts piped stdin without -", (t) => {
  const s = setup(t);
  const badRes = runWithInput(
    ["dispatch"],
    s.env,
    JSON.stringify({ tasks: [{ id: "t1", agent: "alpha", model: "not-declared", cwd: s.root, prompt: "HI" }] }),
  );
  assert.equal(badRes.status, 2);
  assert.match(badRes.stderr, /\[ask-agent\] dispatch: tasks\[0\]\.model: model not-declared is not usable for agent alpha \(not in agents\.alpha\.models\)/);

  const okRes = runWithInput(
    ["dispatch"],
    s.env,
    JSON.stringify({ tasks: [{ id: "t1", agent: "alpha", model: "m-good", cwd: s.root, prompt: "FROM_STDIN" }] }),
  );
  assert.equal(okRes.status, 0, okRes.stderr);
  assert.equal(okRes.stdout, "### t1 (alpha/m-good)\n\nFROM_STDIN\n\n");
});

test("a client task with fallback: true is rejected when any fallback agent is outside client_agents (FR-018)", (t) => {
  const s = setup(t, {}, { policy: { client_agents: ["flaky"] } });
  const marker = join(s.root, "marker.log");
  const env = { ...s.env, STUB_MARKER: marker };
  const withFallback = writeBatch(s.root, {
    tasks: [{ id: "t1", agent: "flaky", cwd: s.root, prompt: "NO", client: true, fallback: true }],
  }, "client-fallback.json");
  const res = runCli(["dispatch", "-f", withFallback], env);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /tasks\[0\]\.client: fallback agent backup is not allowed for client work \(policy client_agents\)/);
  assert.equal(existsSync(marker), false);
  const withoutFallback = writeBatch(s.root, {
    tasks: [{ id: "t1", agent: "flaky", cwd: s.root, prompt: "NO", client: true }],
  }, "client-no-fallback.json");
  assert.notEqual(runCli(["dispatch", "-f", withoutFallback], env).status, 2);
});
