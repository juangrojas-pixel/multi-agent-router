import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

const stub = fixture("stub-ok");
const now = "2026-11-25T10:00:00.000Z";

function baseSetup(
  t: TestContext,
  options: {
    configOverrides?: Record<string, unknown>;
    catalog?: Record<string, unknown>;
    benchmarks?: Record<string, unknown>;
    policy?: Record<string, unknown> | null;
  } = {},
) {
  const config = {
    cooldown_seconds: 3600,
    default_tier: "execute",
    capability_tiers: ["light", "standard", "strong", "frontier"],
    kinds: ["code", "reasoning", "writing", "review"],
    sizes: { s: 20000, m: 80000, l: 250000 },
    cost_ceiling: 5,
    model_aliases: { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" },
    models: {
      "declared-strong": { tier: { code: "strong" } },
    },
    agents: {
      opencode: { enabled: true, command: stub, timeout_seconds: 1, args: ["{prompt}"], output: "text" },
      agy: { enabled: true, command: stub, timeout_seconds: 1, args: ["{prompt}"], output: "text" },
      codex: { enabled: true, command: stub, timeout_seconds: 1, args: ["{prompt}"], output: "text" },
      "gentle-shell": { enabled: true, command: stub, timeout_seconds: 1, args: ["{prompt}"], output: "text" },
      claude: {
        enabled: true, command: stub, timeout_seconds: 1, args: ["{prompt}"], output: "text",
        models: ["sonnet", "opus"], shares_quota_with: "orchestrator",
      },
    },
    ...options.configOverrides,
  };

  const scratch = scratchConfig(config);
  t.after(() => rmSync(scratch.root, { recursive: true, force: true }));

  const cacheDir = join(scratch.env.XDG_CACHE_HOME!, "multi-agent-router");
  mkdirSync(cacheDir, { recursive: true });

  const defaultCatalog = {
    agents: {
      opencode: {
        fetched_at: now,
        source: "cli",
        models: [
          { id: "opencode/free-coder", status: "usable" },
          { id: "opencode/weak-model", status: "usable" },
          { id: "opencode/no-tier-model", status: "usable" },
        ],
      },
      agy: {
        fetched_at: now,
        source: "cli",
        models: [
          { id: "gemini-4-hydrogen-high", status: "usable", quota_group: "Gemini Models", quota_left: 0.99 },
          { id: "gemini-4-neon-high", status: "usable", quota_group: "Gemini Models", quota_left: 0.96 },
          { id: "claude-opus-5-5-high", status: "out_of_quota", quota_group: "Claude and GPT models", quota_left: 0 },
          { id: "retired-model", status: "unavailable", reason: "not listed by agy" },
        ],
      },
      codex: {
        fetched_at: now,
        source: "cli",
        models: [
          { id: "openai-codex/gpt-6.1-terra", status: "usable" },
          { id: "declared-strong", status: "usable" },
        ],
      },
      "gentle-shell": {
        fetched_at: now,
        source: "cli",
        models: [
          { id: "openai-codex/gpt-6.2-sol", status: "usable" },
        ],
      },
      claude: {
        fetched_at: now,
        source: "config",
        models: [
          { id: "sonnet", status: "unverified" },
          { id: "opus", status: "unverified" },
        ],
      },
    },
  };

  const defaultBenchmarks = {
    sources: {
      "models-dev": { fetched_at: now, status: "fresh" },
      lmarena: { fetched_at: now, status: "fresh" },
    },
    models: {
      "free-coder": {
        price_out_per_m: 0,
        scores: { code: { rank: 30, rating: 1380, source: "lmarena", date: "2026-11-22" } },
        tier: { code: "standard" },
      },
      "weak-model": {
        price_out_per_m: 0,
        scores: { code: { rank: 90, rating: 1200, source: "lmarena", date: "2026-11-22" } },
        tier: { code: "light" },
      },
      "gemini-4-hydrogen": {
        price_out_per_m: 5,
        scores: { code: { rank: 20, rating: 1420, source: "lmarena", date: "2026-11-22" } },
        tier: { code: "standard" },
      },
      "gemini-4-neon": {
        price_out_per_m: 15,
        scores: { code: { rank: 2, rating: 1520, source: "lmarena", date: "2026-11-22" } },
        tier: { code: "frontier" },
      },
      "gpt-6-1-terra": {
        price_out_per_m: 15,
        scores: { code: { rank: 10, rating: 1480, source: "lmarena", date: "2026-11-22" } },
        tier: { code: "strong" },
      },
      "gpt-6-2-sol": {
        price_out_per_m: 90,
        scores: { code: { rank: 4, rating: 1500, source: "lmarena", date: "2026-11-22" } },
        tier: { code: "frontier" },
      },
      "claude-sonnet-5-5": {
        price_out_per_m: 15,
        scores: { code: { rank: 6, rating: 1495, source: "lmarena", date: "2026-11-22" } },
        tier: { code: "strong" },
      },
      "claude-opus-5-5": {
        price_out_per_m: 75,
        scores: { code: { rank: 1, rating: 1540, source: "lmarena", date: "2026-11-22" } },
        tier: { code: "frontier" },
      },
      "retired-model": {
        price_out_per_m: 1,
        scores: { code: { rank: 1, rating: 1600, source: "lmarena", date: "2026-11-22" } },
        tier: { code: "frontier" },
      },
    },
  };

  writeFileSync(join(cacheDir, "catalog.json"), JSON.stringify(options.catalog ?? defaultCatalog, null, 2));
  writeFileSync(join(cacheDir, "benchmarks.json"), JSON.stringify(options.benchmarks ?? defaultBenchmarks, null, 2));

  const policyFile = join(scratch.root, "policy.json");
  if (options.policy !== undefined && options.policy !== null) {
    writeFileSync(policyFile, JSON.stringify(options.policy));
  }
  const env: NodeJS.ProcessEnv = {
    ...scratch.env,
    ASK_AGENT_POLICY: policyFile,
  };

  return { root: scratch.root, env };
}

test("ranks capable candidates by lowest est_cost then highest score, skipping out_of_quota/unavailable/below-tier", (t) => {
  const { env } = baseSetup(t);
  const res = runCli(["candidates", "--kind", "code", "--tier", "strong", "-n", "10", "--json"], env);
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  const list = JSON.parse(res.stdout);

  // Expected order for code >= strong at default size m (80,000 tokens):
  // 1. agy/gemini-4-neon-high: price 15 -> cost 1.2, rank 2 (beats sonnet rank 6 and terra rank 10)
  // 2. claude/sonnet (unverified): price 15 -> cost 1.2, rank 6, shares orchestrator quota
  // 3. codex/openai-codex/gpt-6.1-terra: price 15 -> cost 1.2, rank 10
  // 4. claude/opus (unverified): price 75 -> cost 6.0 (> ceiling 5), rank 1, shares orchestrator quota
  // 5. gentle-shell/openai-codex/gpt-6.2-sol: price 90 -> cost 7.2 (> ceiling 5), rank 4
  // 6. codex/declared-strong: declared tier=strong, no price -> cost null (sorts after priced)
  // Excluded: opencode/free-coder (standard < strong), opencode/weak-model (light),
  //   opencode/no-tier-model (no tier), agy/gemini-4-hydrogen-high (standard),
  //   agy/claude-opus-5-5-high (out_of_quota), agy/retired-model (unavailable).
  assert.deepEqual(
    list.map((c: { agent: string; model: string }) => `${c.agent}/${c.model}`),
    [
      "agy/gemini-4-neon-high",
      "claude/sonnet",
      "codex/openai-codex/gpt-6.1-terra",
      "claude/opus",
      "gentle-shell/openai-codex/gpt-6.2-sol",
      "codex/declared-strong",
    ],
  );

  assert.deepEqual(list[0], {
    agent: "agy",
    model: "gemini-4-neon-high",
    tier: "frontier",
    tier_source: "measured",
    est_cost: 1.2,
    quota_left: 0.96,
    over_ceiling: false,
    reason: "cheapest capable",
  });
  assert.equal(list[1].tier_source, "measured");
  assert.equal(list[1].est_cost, 1.2);
  assert.equal(list[1].quota_left, null);
  assert.equal(list[1].over_ceiling, false);
  assert.match(list[1].reason, /shares orchestrator quota/);

  assert.equal(list[3].est_cost, 6);
  assert.equal(list[3].over_ceiling, true);
  assert.match(list[3].reason, /over ceiling 5 -> use #1/);
  assert.match(list[3].reason, /shares orchestrator quota/);

  assert.equal(list[4].est_cost, 7.2);
  assert.equal(list[4].over_ceiling, true);
  assert.match(list[4].reason, /over ceiling 5 -> use #1/);

  assert.equal(list[5].tier, "strong");
  assert.equal(list[5].tier_source, "declared");
  assert.equal(list[5].est_cost, null);
  assert.equal(list[5].over_ceiling, false);
});

test("free model costs 0 and ranks first; size s/m/l scales est_cost; text format matches contract", (t) => {
  const { env } = baseSetup(t);

  // Default size m (80,000): free-coder = 0, hydrogen = 5 * 80000 / 1e6 = 0.4
  const textDefault = runCli(["candidates", "--kind", "code", "--tier", "standard", "-n", "2"], env);
  assert.equal(textDefault.status, 0);
  assert.equal(textDefault.stderr, "");
  const lines = textDefault.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "1  opencode/opencode/free-coder  tier=standard  cost=0  cheapest capable");
  assert.match(lines[1], /^2  agy\/gemini-4-hydrogen-high  tier=standard  cost=0\.4  quota 99%  /);

  // Size s (20,000): hydrogen = 5 * 20000 / 1e6 = 0.1, sol = 90 * 20000 / 1e6 = 1.8 (NOT over ceiling 5)
  const smallRes = runCli(["candidates", "--kind", "code", "--tier", "frontier", "--size", "s", "--json"], env);
  assert.equal(smallRes.status, 0);
  assert.equal(smallRes.stderr, "");
  const small = JSON.parse(smallRes.stdout);
  assert.equal(small[0].est_cost, 0.3); // 15 * 20000 / 1e6
  assert.equal(small[1].est_cost, 1.5); // 75 * 20000 / 1e6
  assert.equal(small[2].est_cost, 1.8); // 90 * 20000 / 1e6
  assert.equal(small[2].over_ceiling, false);

  // Size l (250,000): neon = 15 * 250000 / 1e6 = 3.75 (under 5), sol = 90 * 250000 / 1e6 = 22.5 (over 5)
  const largeRes = runCli(["candidates", "--kind", "code", "--tier", "frontier", "--size", "l"], env);
  assert.equal(largeRes.status, 0);
  assert.equal(largeRes.stderr, "");
  const largeLines = largeRes.stdout.trimEnd().split("\n");
  assert.match(largeLines[0], /^1  agy\/gemini-4-neon-high  tier=frontier  cost=3\.75  quota 96%  cheapest capable$/);
  assert.match(largeLines[1], /^!  claude\/opus  tier=frontier  cost=18\.75  .*over ceiling 5 -> use #1/);
  assert.match(largeLines[1], /shares orchestrator quota/);
  assert.match(largeLines[2], /^!  gentle-shell\/openai-codex\/gpt-6\.2-sol  tier=frontier  cost=22\.5  over ceiling 5 -> use #1$/);
});

test("text output renders declared tier with *, unpriced with cost=?, default -n 5 limit, and agent order tie-break", (t) => {
  const { env } = baseSetup(t, {
    configOverrides: {
      models: {
        "m-a": { tier: { code: "strong" } },
        "m-b": { tier: { code: "strong" } },
      },
    },
    catalog: {
      agents: {
        opencode: { fetched_at: now, source: "cli", models: [{ id: "m-a", status: "usable" }] },
        agy: { fetched_at: now, source: "cli", models: [{ id: "m-b", status: "usable" }] },
        codex: { fetched_at: now, source: "cli", models: [] },
        "gentle-shell": { fetched_at: now, source: "cli", models: [] },
        claude: { fetched_at: now, source: "config", models: [] },
      },
    },
    benchmarks: { sources: {}, models: {} },
  });

  const res = runCli(["candidates", "--kind", "code", "--tier", "strong"], env);
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  const lines = res.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^1  opencode\/m-a  tier=strong\*  cost=\?  /);
  assert.match(lines[1], /^2  agy\/m-b  tier=strong\*  cost=\?  /);

  // Default -n 5 limits to 5 lines when 6 candidates exist
  const full = baseSetup(t);
  const limited = runCli(["candidates", "--kind", "code", "--tier", "strong"], full.env);
  assert.equal(limited.status, 0);
  assert.equal(limited.stderr, "");
  assert.equal(limited.stdout.trimEnd().split("\n").length, 5);
});

test("exits 4 when no candidate meets tier, naming best below on stderr", (t) => {
  const { env } = baseSetup(t, {
    configOverrides: {
      models: {},
    },
    catalog: {
      agents: {
        opencode: { fetched_at: now, source: "cli", models: [{ id: "opencode/weak-model", status: "usable" }] },
        agy: {
          fetched_at: now,
          source: "cli",
          models: [
            { id: "gemini-4-hydrogen-high", status: "usable", quota_group: "Gemini Models", quota_left: 0.9 },
            { id: "claude-opus-5-5-high", status: "out_of_quota", quota_group: "Claude and GPT models", quota_left: 0 },
          ],
        },
        codex: { fetched_at: now, source: "cli", models: [] },
        "gentle-shell": { fetched_at: now, source: "cli", models: [] },
        claude: { fetched_at: now, source: "config", models: [] },
      },
    },
  });

  const res = runCli(["candidates", "--kind", "code", "--tier", "frontier"], env);
  assert.equal(res.status, 4);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "[ask-agent] no candidate meets code>=frontier; best below: agy/gemini-4-hydrogen-high tier=standard\n");

  // Kind with no models tiered at all
  const none = runCli(["candidates", "--kind", "writing", "--tier", "standard"], env);
  assert.equal(none.status, 4);
  assert.equal(none.stdout, "");
  assert.equal(none.stderr, "[ask-agent] no candidate meets writing>=standard\n");
});

test("--client keeps only policy client_agents and fails closed when absent (FR-018)", (t) => {
  // Absent policy -> exit 4
  const noPolicy = baseSetup(t, { policy: null });
  const denied = runCli(["candidates", "--kind", "code", "--tier", "strong", "--client"], noPolicy.env);
  assert.equal(denied.status, 4);
  assert.equal(denied.stdout, "");
  assert.equal(denied.stderr, "[ask-agent] no candidate: no agent allowed for client work (policy client_agents)\n");

  // Policy present without client_agents -> exit 4
  const emptyPolicy = baseSetup(t, { policy: { routing: { notes: "site" } } });
  const denied2 = runCli(["candidates", "--kind", "code", "--tier", "strong", "--client"], emptyPolicy.env);
  assert.equal(denied2.status, 4);
  assert.equal(denied2.stdout, "");
  assert.equal(denied2.stderr, "[ask-agent] no candidate: no agent allowed for client work (policy client_agents)\n");

  // Policy allows only claude and gentle-shell -> agy/codex/opencode excluded
  const allowed = baseSetup(t, { policy: { client_agents: ["claude", "gentle-shell"] } });
  const res = runCli(["candidates", "--kind", "code", "--tier", "strong", "--client", "--json"], allowed.env);
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  const list = JSON.parse(res.stdout);
  assert.deepEqual(
    list.map((c: { agent: string; model: string }) => `${c.agent}/${c.model}`),
    ["claude/sonnet", "claude/opus", "gentle-shell/openai-codex/gpt-6.2-sol"],
  );
  assert.equal(list[0].reason, "cheapest capable; shares orchestrator quota");
  assert.match(list[1].reason, /over ceiling 5 -> use #1/);
  assert.match(list[2].reason, /over ceiling 5 -> use #1/);
});

test("exits 2 with clear errors on unknown kind, tier, size, missing flags, or bad options", (t) => {
  const { env } = baseSetup(t);
  const usage = "usage: ask-agent candidates --kind KIND --tier TIER [--size s|m|l] [--client] [-n N] [--json]";
  const cases: Array<[string[], string]> = [
    [["--kind", "magic", "--tier", "strong"], "unknown kind: magic"],
    [["--kind", "code", "--tier", "godmode"], "unknown tier: godmode"],
    [["--kind", "code", "--tier", "strong", "--size", "xl"], "unknown size: xl"],
    [["--kind", "code"], usage],
    [["--tier", "strong"], usage],
    [[], usage],
    [["--kind", "code", "--tier", "strong", "--bogus"], usage],
    [["--kind", "code", "--tier", "strong", "-n", "0"], usage],
    [["--kind", "code", "--tier", "strong", "-n", "abc"], usage],
  ];

  for (const [args, expected] of cases) {
    const res = runCli(["candidates", ...args], env);
    assert.deepEqual(res, {
      status: 2,
      stdout: "",
      stderr: `[ask-agent] error: ${expected}\n`,
    }, `args: ${args.join(" ")}`);
  }
});

test("effort variants of one model collapse into one line that recommends -high", (t) => {
  const { env } = baseSetup(t, {
    catalog: { agents: { agy: { fetched_at: now, source: "cli", models: [
      { id: "gemini-4-neon-low", status: "usable", quota_group: "Gemini Models", quota_left: 0.96 },
      { id: "gemini-4-neon-medium", status: "usable", quota_group: "Gemini Models", quota_left: 0.96 },
      { id: "gemini-4-neon-high", status: "usable", quota_group: "Gemini Models", quota_left: 0.96 },
      { id: "gemini-4-neon-xhigh", status: "usable", quota_group: "Gemini Models", quota_left: 0.96 },
      { id: "gemini-4-hydrogen-low", status: "usable", quota_group: "Gemini Models", quota_left: 0.96 },
    ] } } },
  });
  const text = runCli(["candidates", "--kind", "code", "--tier", "standard"], env);
  assert.equal(text.status, 0, text.stderr);
  assert.deepEqual(text.stdout.trimEnd().split("\n").filter((line) => line.includes("agy/")), [
    "1  agy/gemini-4-hydrogen-low  tier=standard  cost=0.4  quota 96%  cheapest capable",
    "2  agy/gemini-4-neon-high  efforts=low,medium,high,xhigh  tier=frontier  cost=1.2  quota 96%  frontier tier",
  ]);
  const json = JSON.parse(runCli(["candidates", "--kind", "code", "--tier", "standard", "--json"], env).stdout);
  assert.deepEqual(json.filter((c: { agent: string }) => c.agent === "agy").map((c: { model: string; efforts?: string[] }) => [c.model, c.efforts ?? null]), [
    ["gemini-4-hydrogen-low", null],
    ["gemini-4-neon-high", ["low", "medium", "high", "xhigh"]],
  ]);
});
