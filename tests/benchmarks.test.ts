import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { baseConfig, runCli, scratchConfig } from "./fixtures/helpers.ts";

const ids = ["Google/Gemini 4.Neon (High)", "gemini-4-neon-xhigh", "sonnet", "OpenAI/GPT 6.2 Sol-Pro (High)", "gemini-4-neonn"];
const fixtures = new URL("./fixtures/benchmarks/", import.meta.url);

function setup(t: TestContext) {
  const base = baseConfig() as { agents: { one: Record<string, unknown> } };
  const config = { ...base,
    agents: { one: { ...base.agents.one, models: ids } },
    capability_tiers: ["light", "standard", "strong", "frontier"],
    kinds: ["code", "review"],
    model_aliases: { sonnet: "claude-sonnet-5-5", [ids[0]]: "gemini-4-hydrogen" },
    models: { "gemini-4-neon-xhigh": { tier: { code: "light" } } },
    benchmarks: { max_age_days: 7, sources: [
      { id: "model-prices", parse: "models-dev", url: new URL("models-dev.json", fixtures).href },
      { id: "arena", parse: "lmarena-hf", url: "", categories: { code: ["coding", "webdev"], review: ["hard_prompts"] }, tier_bands: { frontier: 5, strong: 15, standard: 40 } },
      { id: "fallback", parse: "openrouter", url: new URL("openrouter.json", fixtures).href },
      { id: "aa", parse: "artificial-analysis", url: "file:///nonexistent" },
    ] },
  };
  const scratch = scratchConfig(config);
  t.after(() => rmSync(scratch.root, { recursive: true, force: true }));
  const arena = join(scratch.root, "arena.json");
  const real = JSON.parse(readFileSync(new URL("lmarena.json", fixtures), "utf8"));
  const neon = real.rows.find(({ row }: { row: { model_name: string } }) => row.model_name === "Gemini 4 Neon (High)");
  const scored = (category: string, rank: number, rating: number) => ({ ...neon, row: { ...neon.row, category, rank, rating } });
  writeFileSync(arena, JSON.stringify({ ...real, rows: [...real.rows,
    scored("coding", 14, 1500), scored("webdev", 3, 1510), scored("hard_prompts", 41, 1400),
  ] }));
  config.benchmarks.sources[1].url = pathToFileURL(arena).href;
  writeFileSync(scratch.config, JSON.stringify(config));
  const cachePath = join(scratch.env.XDG_CACHE_HOME!, "multi-agent-router", "benchmarks.json");
  return { arena, cachePath, run(...args: string[]) {
    const result = runCli(["catalog", ...args], scratch.env);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    return result.stdout;
  }, cache: () => JSON.parse(readFileSync(cachePath, "utf8")) };
}

test("catalog refresh parses benchmark fixtures, maps names, and marks declared overrides", (t) => {
  const s = setup(t);
  const output = JSON.parse(s.run("--refresh", "--json"));
  const cache = s.cache();
  const scores = {
    code: { rank: 3, rating: 1510, source: "arena", date: "2026-11-22" },
    review: { rank: 41, rating: 1400, source: "arena", date: "2026-11-22" },
  };
  assert.deepEqual(cache.models["gemini-4-neon"], {
    price_out_per_m: 15, price_source: "model-prices", context: 1048576, release_date: "2026-11-18",
    scores, tier: { code: "frontier", review: "light" },
  });
  assert.deepEqual(cache.models["gpt-6-2-sol-pro"], { price_out_per_m: 10, price_source: "fallback" });
  assert.equal(cache.models["gemini-4-neonn"], undefined);
  assert.deepEqual(output.agents.one.models, [
    { id: ids[0], status: "unverified", profile: { tier: {}, tier_source: {}, price_out_per_m: 7.5 } },
    { id: ids[1], status: "unverified", profile: { tier: { code: "light", review: "light" }, tier_source: { code: "declared", review: "measured" }, price_out_per_m: 15, scores } },
    ...[2, 3].map((i) => ({ id: ids[i], status: "unverified", profile: { tier: {}, tier_source: {}, price_out_per_m: 10 } })),
    { id: ids[4], status: "unverified", profile: null },
  ]);
  assert.deepEqual(Object.values(cache.sources as Record<string, { status: string }>).map((entry) => entry.status), ["fresh", "fresh", "fresh", "skipped"]);
  const day = cache.sources.arena.fetched_at.slice(0, 10);
  assert.equal(s.run(), [
    `one  (listed ${output.agents.one.fetched_at.slice(0, 16).replace("T", " ")}, config)`,
    ...["  $out/M=7.5", "  code=light*  review=light  $out/M=15", "  $out/M=10", "  $out/M=10", ""].map((extra, i) => `  unverified    ${ids[i]}${extra}`),
    `sources: model-prices ${day} fresh, arena ${day} fresh, fallback ${day} fresh, aa - skipped`, "",
  ].join("\n"));
  assert.deepEqual(s.cache(), cache);
});

test("unreachable source preserves its cached scores and date, with no background retry", (t) => {
  const s = setup(t);
  s.run("--refresh");
  const previous = s.cache();
  rmSync(s.arena);
  assert.match(s.run(), /arena \d{4}-\d\d-\d\d fresh/);
  assert.deepEqual(s.cache(), previous);
  const text = s.run("--refresh");
  const current = s.cache();
  assert.deepEqual(current.models, previous.models);
  assert.deepEqual(current.sources.arena, { fetched_at: previous.sources.arena.fetched_at, status: "stale", error: "ENOENT" });
  assert.ok(text.includes(`arena ${previous.sources.arena.fetched_at.slice(0, 10)} stale`));
  assert.ok(text.includes("gemini-4-neon-xhigh  code=light*  review=light  $out/M=15"));
});

test("Epoch ZIP measures code first, with per-kind fallback and declared overrides", (t) => {
  const modelIds = ["opus", "claude-sonnet-5-5-high", "gemini-4-carbon-high", "gpt-6-astra", "low-model", "gpt-5.6-sol", "arena-only"];
  const base = baseConfig() as { agents: { one: Record<string, unknown> } };
  const epoch = { id: "epoch", parse: "epoch-zip", url: "", files: {
    code: { file: "frontierswe_external.csv", model_column: "Model version", score_column: "Score" },
    review: { file: "stored.csv", model_column: "Model version", score_column: "Score" },
  }, score_bands: { frontier: 0.60, strong: 0.50, standard: 0.35 } };
  const arena = { id: "arena", parse: "lmarena-hf", url: "", categories: { code: ["coding"], writing: ["creative_writing"] }, tier_bands: { frontier: 5, strong: 15, standard: 40 } };
  const config = { ...base, agents: { one: { ...base.agents.one, models: modelIds } },
    capability_tiers: ["light", "standard", "strong", "frontier"], kinds: ["code", "writing", "review"],
    model_aliases: { opus: "claude-opus-5-5" }, models: { "gpt-6-astra": { tier: { code: "standard" } } },
    benchmarks: { sources: [epoch, arena] } };
  const s = scratchConfig(config);
  t.after(() => rmSync(s.root, { recursive: true, force: true }));
  const zip = readFileSync(new URL("epoch.zip", fixtures));
  const zipPath = join(s.root, "epoch.zip");
  const arenaPath = join(s.root, "arena.json");
  writeFileSync(zipPath, zip);
  const arenaRow = (model_name: string, category: string, rank: number) => ({ row: { model_name, category, rank, rating: 1500, leaderboard_publish_date: "2026-11-22" } });
  writeFileSync(arenaPath, JSON.stringify({ rows: [arenaRow("claude-sonnet-5-5", "coding", 1),
    arenaRow("claude-sonnet-5-5", "creative_writing", 32), arenaRow("arena-only", "coding", 1)] }));
  epoch.url = pathToFileURL(zipPath).href;
  arena.url = pathToFileURL(arenaPath).href;
  writeFileSync(s.config, JSON.stringify(config));
  const run = (...args: string[]) => {
    const result = runCli(["catalog", "--refresh", ...args], s.env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  const cache = () => JSON.parse(readFileSync(join(s.env.XDG_CACHE_HOME!, "multi-agent-router", "benchmarks.json"), "utf8"));
  const output = JSON.parse(run("--json"));
  const initial = cache();
  const date = initial.sources.epoch.fetched_at;
  assert.equal(initial.sources.epoch.status, "fresh");
  const measured = (score: number, date: string) => ({ score, date, source: "epoch" });
  const ranked = (rank: number) => ({ rank, rating: 1500, source: "arena", date: "2026-11-22" });
  const expected = [
    ["claude-opus-5-5", { code: "frontier" }, { code: measured(0.61, "2026-11-20") }],
    ["claude-sonnet-5-5", { code: "strong", writing: "standard" }, { code: measured(0.50, date), writing: ranked(32) }],
    ["gemini-4-carbon", { code: "standard" }, { code: measured(0.35, date) }],
    ["gpt-6-astra", { code: "frontier" }, { code: measured(0.60, date) }],
    ["low-model", { code: "light" }, { code: measured(0.1, date) }],
    ["gpt-5-6-sol", { review: "strong" }, { review: measured(0.51, date) }],
    ["arena-only", { code: "frontier" }, { code: ranked(1) }],
  ] as const;
  assert.deepEqual(initial.models, Object.fromEntries(expected.map(([id, tier, scores]) => [id, { tier, scores }])));
  assert.deepEqual(output.agents.one.models, expected.map(([, tier, scores], i) => ({ id: modelIds[i], status: "unverified", profile: {
    scores, tier: i === 3 ? { code: "standard" } : tier,
    tier_source: Object.fromEntries(Object.keys(tier).map((kind) => [kind, i === 3 ? "declared" : "measured"])),
  } })));

  // Set both headers of the deflated entry to an unsupported method.
  zip.writeUInt16LE(99, 8);
  zip.writeUInt16LE(99, zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
  writeFileSync(zipPath, zip);
  const text = run();
  assert.deepEqual(cache().models, initial.models);
  assert.deepEqual(cache().sources.epoch, { fetched_at: date, status: "stale", error: "benchmark fetch or parse failed" });
  assert.ok(text.includes(`sources: epoch ${date.slice(0, 10)} stale, arena `));
  assert.ok(text.includes("claude-sonnet-5-5-high  code=strong  writing=standard"));
});
