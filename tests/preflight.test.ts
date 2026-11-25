import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

const stub = fixture("stub-preflight");
const update = `${stub} update`;
const agent = {
  enabled: true, command: stub, version_cmd: [stub, "version"], latest_cmd: [stub, "latest"],
  update_cmd: update, models: ["model-3"], list_models: { cmd: [stub, "models"], parse: "tsv" },
};
const modelsLine = "  models: 2 usable, 1 unavailable, 0 out_of_quota, 0 unverified\n";
const benchmarks = { max_age_days: 7, sources: [{ id: "demo", url: "https://example.invalid", parse: "models-dev" }] };

function setup(t: TestContext, config: object) {
  const scratch = scratchConfig(config);
  const { root } = scratch;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "calls");
  const dir = join(scratch.env.XDG_CACHE_HOME!, "multi-agent-router");
  mkdirSync(dir);
  const env = { ...scratch.env, ASK_AGENT_POLICY: join(root, "config", "absent.json"), STUB_MARKER: marker,
    STUB_INSTALLED: "tool 1.9.0 (engine 99.0.0)", STUB_LATEST: "1.9.0", STUB_OFFLINE: "0", STUB_DELAY: "0" };
  const original = snapshot();
  function snapshot() {
    return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((item) => item.parentPath !== dir && !item.name.startsWith("calls"))
      .map((item) => {
        const path = join(item.parentPath, item.name);
        return [path, item.isDirectory() ? "directory" : readFileSync(path, "utf8")];
      }));
  }
  function checkState(calls: string[], catalog: Record<string, unknown> | null, benchmarkCache?: string) {
    assert.deepEqual(snapshot(), original);
    assert.deepEqual(existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").sort() : [], calls.sort());
    assert.deepEqual(readdirSync(dir).sort(), [...(benchmarkCache === undefined ? [] : ["benchmarks.json"]), ...(catalog ? ["catalog.json"] : [])]);
    if (catalog) {
      const actual = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
      for (const value of Object.values(actual.agents) as Array<{ fetched_at: string }>) {
        assert.equal(new Date(value.fetched_at).toISOString(), value.fetched_at);
        Reflect.deleteProperty(value, "fetched_at");
      }
      assert.deepEqual(actual, { agents: catalog });
    }
    if (benchmarkCache !== undefined) assert.equal(readFileSync(join(dir, "benchmarks.json"), "utf8"), benchmarkCache);
  }
  return { env, dir, checkState };
}

const listed = { source: "cli", models: [
  { id: "model-1", status: "usable" }, { id: "model-2", status: "usable" },
  { id: "model-3", status: "unavailable", reason: "not listed by one" },
] };
const calls = ["version", "latest", "models"];

// An installed version newer than the registry's latest (a prerelease or a lagging registry) is not behind.
for (const [latest, status, exit] of [["1.9.0", "current", 0], ["1.10.0", "outdated", 3], ["1.8.5", "current", 0]] as const) {
  test(`preflight ${status} with latest ${latest}, reporting only`, (t) => {
    const s = setup(t, { agents: { one: agent, disabled: { ...agent, enabled: false } } });
    assert.deepEqual(runCli(["preflight"], { ...s.env, STUB_LATEST: latest }), {
      status: exit, stderr: "", stdout: `one  version 1.9.0 (latest ${latest}, ${status})\n${modelsLine}` +
        (exit ? `  update: ${update}\n` : "") + `benchmarks: not configured\npreflight: ${exit ? "outdated" : "ready"}\n`,
    });
    s.checkState([...calls], { one: listed });
  });
}

for (const offline of [false, true]) {
  test(`preflight unknown with ${offline ? "failed latest lookup" : "null latest_cmd"}, including agy quota`, (t) => {
    const s = setup(t, { agents: { agy: { ...agent, latest_cmd: offline ? agent.latest_cmd : null,
      models: ["model-4"], quota_groups: { "model-1": "family" }, quota: { min_remaining: 0.5 } } } });
    const expected = { agents: { agy: {
      version: { installed: "1.9.0", latest: null, status: "unknown", update_cmd: update },
      quota: 0.25, models: { usable: 1, unavailable: 1, out_of_quota: 1, unverified: 0 },
    } }, benchmarks: "not configured" };
    assert.deepEqual(runCli(["preflight", "--json"], { ...s.env, STUB_OFFLINE: offline ? "1" : "0" }), {
      status: 0, stderr: "", stdout: `${JSON.stringify(expected, null, 2)}\n`,
    });
    s.checkState(["version", "models", "-p /usage --output-format json --print-timeout 30s", ...(offline ? ["latest"] : [])], { agy: {
      source: "cli", models: [{ id: "model-1", status: "out_of_quota", quota_group: "family", quota_left: 0.25 },
        { id: "model-2", status: "usable" }, { id: "model-4", status: "unavailable", reason: "not listed by agy" }],
    } });
  });
}

test("preflight fails if no catalog can be built", (t) => {
  const s = setup(t, { agents: { one: { ...agent, models: [], list_models: { cmd: [stub, "fail"], parse: "tsv" } } } });
  assert.deepEqual(runCli(["preflight"], s.env), { status: 1, stderr: "",
    stdout: "one  version 1.9.0 (latest 1.9.0, current)\n  models: 0 usable, 0 unavailable, 0 out_of_quota, 0 unverified\nbenchmarks: not configured\npreflight: failed\n" });
  s.checkState(["version", "latest", "fail"], { one: { source: "config", models: [] } });
});

for (const [status, days, exit] of [["fresh", 1, 0], ["stale", 8, 3], ["missing", null, 3]] as const) {
  test(`preflight reports ${status} benchmarks`, (t) => {
    const s = setup(t, { agents: { one: agent }, benchmarks });
    const cache = days === null ? undefined : JSON.stringify({ sources: {
      demo: { fetched_at: new Date(Date.now() - days * 86_400_000).toISOString() },
    } });
    if (cache !== undefined) writeFileSync(join(s.dir, "benchmarks.json"), cache);
    assert.deepEqual(runCli(["preflight"], s.env), { status: exit, stderr: "",
      stdout: `one  version 1.9.0 (latest 1.9.0, current)\n${modelsLine}benchmarks: ${status}\npreflight: ${exit ? "outdated" : "ready"}\n` });
    s.checkState([...calls], { one: listed }, cache);
  });
}

test("preflight rejects extra arguments without running checks", (t) => {
  const s = setup(t, { agents: { one: agent } });
  assert.deepEqual(runCli(["preflight", "--bad"], s.env), { status: 2, stdout: "",
    stderr: "[ask-agent] error: usage: ask-agent preflight [--json] [--update]\n" });
  s.checkState([], null);
});

test("preflight checks five agents concurrently and finishes under 60 seconds", (t) => {
  const ids = ["one", "two", "three", "four", "five"];
  const s = setup(t, { agents: Object.fromEntries(ids.map((id) => [id, { ...agent, models: [] }])) });
  const start = performance.now();
  const result = runCli(["preflight"], { ...s.env, STUB_DELAY: "2" });
  const seconds = (performance.now() - start) / 1000;
  assert.ok(seconds < 9, `expected concurrent checks under 60 s, took ${seconds.toFixed(2)} s`);
  const lines = "  models: 2 usable, 0 unavailable, 0 out_of_quota, 0 unverified\n";
  assert.deepEqual(result, { status: 0, stderr: "", stdout: ids.map((id) =>
    `${id}  version 1.9.0 (latest 1.9.0, current)\n${lines}`).join("") + "benchmarks: not configured\npreflight: ready\n" });
  s.checkState(ids.flatMap(() => calls), Object.fromEntries(ids.map((id) => [id, { ...listed, models: listed.models.slice(0, 2) }])));
});

// An agent CLI that prints no models (seen with `opencode models` on 2026-11-25) is a failed listing:
// preflight keeps the last listed models instead of caching an empty list.
test("preflight keeps the cached model list when an agent lists no models", (t) => {
  const s = setup(t, { agents: { one: agent } });
  const report = `one  version 1.9.0 (latest 1.9.0, current)\n${modelsLine}benchmarks: not configured\npreflight: ready\n`;
  assert.deepEqual(runCli(["preflight"], s.env), { status: 0, stderr: "", stdout: report });
  assert.deepEqual(runCli(["preflight"], { ...s.env, STUB_MODELS_EMPTY: "1" }), { status: 0, stderr: "", stdout: report });
  s.checkState([...calls, ...calls], { one: listed });
});

// --update runs update_cmd only for outdated agents, sends their output to stderr, then re-checks.
// Each agent keeps its own installed version in the stub, so an update reaches only its agent.
function own(id: string, extra: object = {}) {
  return { ...agent, version_cmd: [stub, "version", id], update_cmd: `${stub} update ${id}`, ...extra };
}
const otherModels = (id: string) => ({ ...listed, models: [listed.models[0], listed.models[1], { ...listed.models[2], reason: `not listed by ${id}` }] });

for (const fail of [false, true]) {
  test(`preflight --update ${fail ? "reports a failed update and stays outdated" : "updates outdated agents and re-checks"}`, (t) => {
    const s = setup(t, { agents: { one: own("one"), two: own("two", { latest_cmd: null }) } });
    const result = runCli(["preflight", "--update"], { ...s.env, STUB_LATEST: "1.10.0", STUB_UPDATE_FAIL: fail ? "1" : "0" });
    const version = fail ? "1.9.0 (latest 1.10.0, outdated)" : "1.10.0 (latest 1.10.0, current)";
    assert.deepEqual(result, {
      status: fail ? 3 : 0,
      stderr: `[ask-agent] updating one: ${stub} update one\n` +
        (fail ? "update failed: registry down\n[ask-agent] update of one failed (exit 4)\n" : "installed 1.10.0\n[ask-agent] updated one\n"),
      stdout: `one  version ${version}\n${modelsLine}` + (fail ? `  update: ${stub} update one\n` : "") +
        `two  version 1.9.0 (latest unknown, unknown)\n${modelsLine}` +
        `benchmarks: not configured\npreflight: ${fail ? "outdated" : "ready"}\n`,
    });
    s.checkState(["version one", "latest", "version two", "update one", "version one", "latest", "version two", "models", "models"],
      { one: listed, two: otherModels("two") });
  });
}

test("preflight --update --json lists each update with its exit status", (t) => {
  const s = setup(t, { agents: { one: agent } });
  const result = runCli(["preflight", "--json", "--update"], { ...s.env, STUB_LATEST: "1.10.0" });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, `[ask-agent] updating one: ${update}\ninstalled 1.10.0\n[ask-agent] updated one\n`);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.updates, { one: { command: update, exit: 0 } });
  assert.equal(report.agents.one.version.status, "current");
});

test("preflight --update with everything current runs no update", (t) => {
  const s = setup(t, { agents: { one: agent } });
  assert.deepEqual(runCli(["preflight", "--update"], s.env), { status: 0, stderr: "",
    stdout: `one  version 1.9.0 (latest 1.9.0, current)\n${modelsLine}benchmarks: not configured\npreflight: ready\n` });
  s.checkState(["version", "latest", ...calls], { one: listed });
});

test("preflight --update names an outdated agent without update_cmd and skips it", (t) => {
  const s = setup(t, { agents: { one: { ...agent, update_cmd: undefined } } });
  const result = runCli(["preflight", "--json", "--update"], { ...s.env, STUB_LATEST: "1.10.0" });
  assert.equal(result.status, 3);
  assert.equal(result.stderr, "[ask-agent] one is outdated but has no update_cmd\n");
  assert.deepEqual(JSON.parse(result.stdout).updates, {});
  s.checkState(["version", "latest", ...calls], { one: listed });
});

test("preflight --update exits 3 when an update fails even if the agent reads current", (t) => {
  const s = setup(t, { agents: { one: own("one", { update_cmd: `${stub} update one; exit 5` }) } });
  const result = runCli(["preflight", "--update"], { ...s.env, STUB_LATEST: "1.10.0" });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /update of one failed \(exit 5\)/);
});

test("preflight --update kills a hung update with its whole process group and says it timed out", async (t) => {
  const s = setup(t, { agents: { one: agent } });
  const result = runCli(["preflight", "--json", "--update"], { ...s.env, STUB_LATEST: "1.10.0", STUB_UPDATE_HANG: "1",
    ASK_AGENT_UPDATE_TIMEOUT_MS: "300" });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /update of one timed out after 0\.3 s/);
  assert.deepEqual(JSON.parse(result.stdout).updates, { one: { command: update, exit: 124, timed_out: true } });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(existsSync(join(s.env.STUB_MARKER!, "..", "calls.late")), false, "a descendant of the update outlived the timeout");
});
