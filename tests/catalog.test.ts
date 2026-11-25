import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

const stub = fixture("stub-models");
const agent = { enabled: true, command: stub };
const list = (data: string, parse = "tsv") => ({ cmd: [stub, "models", data], parse });

function setup(t: TestContext, agents: object) {
  const { root, env } = scratchConfig({ agents });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "invocations");
  const cache = join(env.XDG_CACHE_HOME!, "multi-agent-router", "catalog.json");
  return { env: { ...env, STUB_MARKER: marker }, marker, cache };
}

function json(args: string[], env: NodeJS.ProcessEnv) {
  const result = runCli(["catalog", ...args, "--json"], env);
  assert.deepEqual({ status: result.status, stderr: result.stderr }, { status: 0, stderr: "" });
  return JSON.parse(result.stdout);
}

function snapshot(source: string, models: object[], actual: { fetched_at: string }) {
  assert.equal(new Date(actual.fetched_at).toISOString(), actual.fetched_at);
  return { fetched_at: actual.fetched_at, source, models };
}

const usable = (id: string) => ({ id, status: "usable" });
const unavailable = (id: string, agentId: string) => ({ id, status: "unavailable", reason: `not listed by ${agentId}` });
const unverified = (id: string) => ({ id, status: "unverified" });
const saved = (cache: string) => JSON.parse(readFileSync(cache, "utf8"));

test("discovers enabled agents and isolates missing, failed and timed-out listings", (t) => {
  const { env, cache, marker } = setup(t, {
    one: { ...agent, models: ["a", "c"], list_models: list("a\tDescription\n\nb\tDetails\na\tDuplicate\n") },
    broken: { ...agent, models: ["x"], list_models: { cmd: [stub, "fail"], parse: "tsv" } },
    absent: { ...agent, models: ["y"] },
    slow: { ...agent, models: ["z"], list_models: { cmd: [stub, "slow"], parse: "tsv", timeout_seconds: 0.1 } },
    two: { ...agent, list_models: list("Fetching available models...\nprovider model context\nopenai/gpt-6.2-sol 128k\nsonnet\n", "lines-first-field") },
    disabled: { ...agent, enabled: false, list_models: list("no\n") },
  });
  const output = json([], env);
  assert.deepEqual(output, { agents: {
    one: snapshot("cli", [usable("a"), usable("b"), unavailable("c", "one")], output.agents.one),
    broken: snapshot("config", [unverified("x")], output.agents.broken),
    absent: snapshot("config", [unverified("y")], output.agents.absent),
    slow: snapshot("config", [unverified("z")], output.agents.slow),
    two: snapshot("cli", [usable("openai/gpt-6.2-sol"), usable("sonnet")], output.agents.two),
  } });
  assert.deepEqual(saved(cache), output);
  assert.equal(readFileSync(marker, "utf8"), "models\nfail\nslow\nmodels\n");
});

test("an agent that lists no models counts as a failed listing", (t) => {
  const { env } = setup(t, { quiet: { ...agent, models: ["x"], list_models: list("\n") } });
  const output = json([], env);
  assert.deepEqual(output, { agents: { quiet: snapshot("config", [unverified("x")], output.agents.quiet) } });
});

test("targeted refresh merges caches and updates model status from quota and listings", (t) => {
  const { env, cache, marker } = setup(t, {
    agy: { ...agent, models: ["gemini-fast", "opus", "retired"], list_models: { cmd: [stub, "models"], parse: "tsv" },
      quota: { group: "Gemini", min_remaining: 0.2 }, quota_groups: { "gemini-*": "Gemini", "*": "Other" } },
    other: { ...agent, list_models: list("alpha\n") },
  });
  assert.deepEqual(Object.keys(json(["-a", "other"], env).agents), ["other"]);
  const other = saved(cache).agents.other;
  const refresh = () => json(["-a", "agy", "--refresh"], env);
  const usage = (fraction: number) => JSON.stringify({ command: { data: { groups: [
    { name: "Gemini", buckets: [{ remaining_fraction: 0.9 }, { remaining_fraction: fraction }] },
    { name: "Other", buckets: [{ remaining_fraction: 0.8 }] },
  ] } } });
  env.STUB_MODELS = "gemini-fast\nopus\nretired\n";
  env.STUB_USAGE = usage(0.1);
  const gemini = { ...usable("gemini-fast"), quota_group: "Gemini", quota_left: 0.1, status: "out_of_quota" };
  const opus = { ...usable("opus"), quota_group: "Other", quota_left: 0.8 };
  const retired = { ...usable("retired"), quota_group: "Other", quota_left: 0.8 };
  const first = refresh();
  assert.deepEqual(first, { agents: { agy: snapshot("cli", [gemini, opus, retired], first.agents.agy) } });
  const time = first.agents.agy.fetched_at.slice(0, 16).replace("T", " ");
  assert.deepEqual(runCli(["catalog", "-a", "agy"], env), { status: 0, stderr: "", stdout:
    `agy  (listed ${time}, cli)\n  out_of_quota  gemini-fast  quota 10% (Gemini)\n  usable        opus  quota 80% (Other)\n  usable        retired  quota 80% (Other)\n` });
  assert.deepEqual(saved(cache), { agents: { ...first.agents, other } });
  env.STUB_MODELS = "gemini-fast\nopus\n";
  env.STUB_USAGE = usage(0.2);
  const second = refresh();
  assert.deepEqual(second, { agents: { agy: snapshot("cli", [
    { ...gemini, status: "usable", quota_left: 0.2 }, opus, { ...unavailable("retired", "agy"), quota_group: "Other", quota_left: 0.8 },
  ], second.agents.agy) } });
  assert.deepEqual(saved(cache), { agents: { ...second.agents, other } });
  assert.equal(readFileSync(marker, "utf8"), "models\nmodels\n-p\nmodels\n-p\n");
});

test("refreshes five stubs in under 30 seconds and reads cache in under one second without invoking stubs", (t) => {
  const ids = ["a", "b", "c", "d", "e"];
  const { env, cache, marker } = setup(t, Object.fromEntries(ids.map((id) => [id, { ...agent, list_models: list(`model-${id}\n`) }])));
  let start = performance.now();
  const refreshed = json(["--refresh"], env);
  assert.ok(performance.now() - start < 30_000);
  assert.deepEqual(refreshed, { agents: Object.fromEntries(ids.map((id) => [id,
    snapshot("cli", [usable(`model-${id}`)], refreshed.agents[id]),
  ])) });
  assert.deepEqual(saved(cache), refreshed);
  const bytes = readFileSync(cache, "utf8");
  start = performance.now();
  const cached = json([], env);
  assert.ok(performance.now() - start < 1_000);
  assert.deepEqual(cached, refreshed);
  assert.equal(readFileSync(cache, "utf8"), bytes);
  assert.equal(readFileSync(marker, "utf8"), "models\n".repeat(5));
});

test("argument errors do not run an agent or create a cache", (t) => {
  const { env, cache, marker } = setup(t, { one: { ...agent, list_models: list("a\n") } });
  const usage = "usage: ask-agent catalog [-a AGENT] [--refresh] [--json]";
  for (const [args, error] of [[ ["--bad"], usage ], [ ["-a"], usage ], [ ["-a", "toString"], "unknown agent: toString" ]] as const) {
    assert.deepEqual(runCli(["catalog", ...args], env), { status: 2, stdout: "", stderr: `[ask-agent] error: ${error}\n` });
    assert.equal(existsSync(cache), false);
    assert.equal(existsSync(marker), false);
  }
});

test("pi-table joins provider and model columns and skips warnings and the header", (t) => {
  const table = [
    "Warning: Extension package \"builtin:codemode\" registers tool `codemode`.",
    "provider      model          context  max-out  thinking  images",
    "openai-codex  gpt-6.2-sol    272K     128K     yes       yes",
    "openai        gpt-6.1-terra  400K     128K     yes       yes",
    "openai        gpt-7          1.05M    128K     yes       yes",
    "",
  ].join("\n");
  const { env, cache } = setup(t, { pi: { ...agent, list_models: list(table, "pi-table") } });
  const catalog = json(["--refresh"], env);
  assert.deepEqual(catalog.agents.pi.models, [usable("openai-codex/gpt-6.2-sol"), usable("openai/gpt-6.1-terra"), usable("openai/gpt-7")]);
  assert.deepEqual(saved(cache).agents.pi.models, catalog.agents.pi.models);
});

test("a cached catalog still lists an agent enabled after the last refresh", (t) => {
  const { env, cache } = setup(t, { one: { ...agent, list_models: list("a\n") } });
  json(["--refresh"], env);
  const config = JSON.parse(readFileSync(env.ASK_AGENT_CONFIG!, "utf8"));
  config.agents.two = { ...agent, list_models: list("b\n") };
  writeFileSync(env.ASK_AGENT_CONFIG!, JSON.stringify(config));
  const catalog = json([], env);
  assert.deepEqual(Object.keys(catalog.agents).sort(), ["one", "two"]);
  assert.deepEqual(catalog.agents.two.models, [usable("b")]);
  assert.deepEqual(Object.keys(saved(cache).agents).sort(), ["one", "two"]);
});

test("catalog --refresh runs benchmark refresh and agent listing concurrently", async (t) => {
  const { root, env } = scratchConfig({ agents: {} });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const benchMarker = join(root, "bench-started");
  const agentMarker = join(root, "agent-started");
  const server = createServer((_req, res) => {
    writeFileSync(benchMarker, "1");
    let ticks = 0;
    const poll = setInterval(() => {
      ticks += 1;
      if (existsSync(agentMarker)) {
        clearInterval(poll);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ openai: { models: { "model-a": { cost: { output: 5 } } } } }));
      } else if (ticks >= 50) {
        clearInterval(poll);
        res.writeHead(500);
        res.end("serial refresh timed out");
      }
    }, 20);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as AddressInfo;
  const barrierStub = fixture("p11b-barrier-models");
  writeFileSync(env.ASK_AGENT_CONFIG!, JSON.stringify({
    agents: { one: { enabled: true, command: barrierStub, list_models: { cmd: [barrierStub], parse: "tsv" } } },
    benchmarks: { sources: [{ id: "demo", parse: "models-dev", url: `http://127.0.0.1:${port}/models.json` }] },
  }));
  const cli = resolve(import.meta.dirname, "../bin/ask-agent-ts");
  const { stdout, stderr } = await promisify(execFile)(cli, ["catalog", "--refresh", "--json"], {
    encoding: "utf8",
    env: { ...env, BARRIER_BENCH: benchMarker, BARRIER_AGENT: agentMarker },
  });
  assert.equal(stderr, "");
  const output = JSON.parse(stdout);
  assert.equal(output.agents.one.source, "cli");
  assert.deepEqual(output.agents.one.models, [{
    id: "model-a", status: "usable", profile: { tier: {}, tier_source: {}, price_out_per_m: 5 },
  }]);
  const benchCache = JSON.parse(readFileSync(join(env.XDG_CACHE_HOME!, "multi-agent-router", "benchmarks.json"), "utf8"));
  assert.equal(benchCache.sources.demo.status, "fresh");
});
