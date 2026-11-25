import { readFile } from "node:fs/promises";
import type { Config } from "./config.ts";
import { readCache, writeCache } from "./state.ts";

type Source = NonNullable<NonNullable<Config["benchmarks"]>["sources"]>[number] & {
  categories?: Record<string, string[]>; tier_bands?: Record<string, number>; api_key?: string;
};
type Score = { rank: number; rating: number; source: string; date: string };
type Model = {
  price_out_per_m?: number; price_source?: string; context?: number; release_date?: string;
  scores?: Record<string, Score>; tier?: Record<string, string>;
  output_tokens_per_second?: number; speed_source?: string;
};
type Models = Record<string, Model>;
type SourceStatus = { fetched_at: string | null; status: "fresh" | "stale" | "skipped" | "failed"; error?: string };
export type BenchmarkCache = { sources: Record<string, SourceStatus>; models: Models };
export type BenchmarkProfile = {
  tier: Record<string, string>; tier_source: Record<string, "measured" | "declared">;
  price_out_per_m?: number; scores?: Record<string, Score>;
};
type Snapshot = { status: SourceStatus; models?: Models; parse: string };
const cacheName = "benchmarks.json";
// Keep independent contributions so a stale source can be recombined with fresh ones,
// including values hidden by precedence in the public cache.
const snapshotsName = "benchmark-sources.json";

function normalize(id: string): string {
  return id.toLowerCase().trim().replace(/^[^/]+\//, "").replace(/\s*\([^()]*\)\s*$/, "").replace(/[.\s]+/g, "-");
}

function withoutEffort(id: string): string {
  return id.replace(/-(?:low|medium|high|xhigh)$/, "");
}

function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

export function profileFor(config: Config, cache: BenchmarkCache | null, agentModelId: string): BenchmarkProfile | null {
  const normalized = normalize(agentModelId);
  const base = withoutEffort(normalized);
  const aliases = config.model_aliases;
  const alias = own(aliases, agentModelId) ?? own(aliases, normalized) ?? own(aliases, base);
  const measured = own(cache?.models, alias === undefined ? base : normalize(alias));
  const declared = (own(config.models, agentModelId) ?? own(config.models, normalized) ?? own(config.models, base))?.tier;
  if ((!measured?.scores && measured?.price_out_per_m === undefined) && !Object.keys(declared ?? {}).length) return null;
  const tier = { ...measured?.tier, ...declared };
  return { tier,
    tier_source: Object.fromEntries(Object.keys(tier).map((kind) => [kind, own(declared, kind) === undefined ? "measured" : "declared"])),
    ...(measured?.price_out_per_m === undefined ? {} : { price_out_per_m: measured.price_out_per_m }),
    ...(measured?.scores ? { scores: measured.scores } : {}),
  };
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function modelsDev(payload: Record<string, { models?: Record<string, { cost?: { output?: number }; limit?: { context?: number }; release_date?: string }> }>, source: Source): Models {
  const models: Models = Object.create(null);
  // Prefer first-party pricing over duplicate reseller copies when both are listed.
  const native = new Set(["anthropic", "google", "openai"]);
  const providers = Object.entries(payload).sort(([a], [b]) => Number(native.has(b)) - Number(native.has(a)));
  for (const [, provider] of providers) {
    for (const [id, entry] of Object.entries(provider?.models ?? {})) {
      const model = models[normalize(id)] ??= {};
      if (model.price_out_per_m === undefined && number(entry?.cost?.output)) {
        model.price_out_per_m = entry.cost.output;
        model.price_source = source.id;
      }
      if (model.context === undefined && number(entry?.limit?.context)) model.context = entry.limit.context;
      if (model.release_date === undefined && typeof entry?.release_date === "string") model.release_date = entry.release_date;
    }
  }
  if (!providers.some(([, provider]) => provider?.models)) throw new Error("invalid models.dev response");
  return models;
}

type ArenaRow = { row?: { model_name?: string; rating?: number; rank?: number; category?: string; leaderboard_publish_date?: string } };
function arenaModels(rows: ArenaRow[], source: Source, config: Config, date: string): Models {
  const models: Models = Object.create(null);
  for (const { row } of rows) {
    if (typeof row?.model_name !== "string" || !number(row.rank) || row.rank < 1 || !number(row.rating)) continue;
    for (const [kind, categories] of Object.entries(source.categories ?? {})) {
      if (!categories.includes(row.category ?? "")) continue;
      const model = models[normalize(row.model_name)] ??= {};
      const scores = model.scores ??= Object.create(null);
      if (scores[kind] && scores[kind].rank <= row.rank) continue;
      scores[kind] = { rank: row.rank, rating: row.rating, source: source.id, date: row.leaderboard_publish_date || date };
      const tiers = config.capability_tiers ?? [];
      const tier = tiers.findLast((name) => row.rank! <= (own(source.tier_bands, name) ?? 0)) ?? tiers[0];
      if (tier !== undefined) (model.tier ??= Object.create(null))[kind] = tier;
    }
  }
  return models;
}

type PriceEntry = { id?: string; pricing?: { completion?: string }; slug?: string; median_output_tokens_per_second?: number };
function arrayModels(payload: { data?: PriceEntry[] }, source: Source): Models {
  if (!Array.isArray(payload?.data)) throw new Error("invalid model list response");
  const models: Models = Object.create(null);
  for (const entry of payload.data) {
    if (source.parse === "openrouter") {
      const completion = entry?.pricing?.completion;
      if (typeof entry?.id !== "string" || typeof completion !== "string" || !completion.trim()) continue;
      const price = Number(completion) * 1_000_000;
      if (number(price)) models[normalize(entry.id)] = { price_out_per_m: price, price_source: source.id };
    } else if (typeof entry?.slug === "string" && number(entry.median_output_tokens_per_second)) {
      models[normalize(entry.slug)] = { output_tokens_per_second: entry.median_output_tokens_per_second, speed_source: source.id };
    }
  }
  return models;
}

async function readSource(url: URL, signal: AbortSignal, apiKey?: string) {
  if (url.protocol === "file:") return JSON.parse(await readFile(url, { encoding: "utf8", signal }));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported source protocol");
  if (apiKey && url.protocol !== "https:") throw new Error("benchmark API key requires HTTPS");
  const response = await fetch(url, { signal, ...(apiKey ? { headers: { "x-api-key": apiKey }, redirect: "error" } : {}) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function fetchModels(source: Source, config: Config, date: string): Promise<Models> {
  const url = new URL(source.url);
  // One timeout per request: a shared one made a paginated source fail when pages and the other
  // sources were fetched at the same time.
  const signal = () => AbortSignal.timeout(15_000);
  const payload = await readSource(url, signal(), source.parse === "artificial-analysis" ? source.api_key : undefined);
  if (source.parse === "models-dev") return modelsDev(payload, source);
  if (source.parse !== "lmarena-hf") return arrayModels(payload, source);
  if (!Array.isArray(payload?.rows)) throw new Error("invalid LMArena response");
  const rows: ArenaRow[] = [...payload.rows];
  // Hugging Face keeps responses paginated even when the filter selects only mapped categories.
  if (url.hostname === "datasets-server.huggingface.co" && ["/rows", "/filter"].includes(url.pathname)) {
    const start = Number(url.searchParams.get("offset") ?? 0);
    const length = payload.rows.length;
    const total = payload.num_rows_total;
    for (let offset = start + length; length > 0 && offset < total; offset += length * 6) {
      const pages = await Promise.all(Array.from({ length: Math.min(6, Math.ceil((total - offset) / length)) }, (_, i) => {
        const page = new URL(url);
        page.searchParams.set("offset", String(offset + i * length));
        page.searchParams.set("length", String(length));
        return readSource(page, signal());
      }));
      for (const page of pages) {
        if (!Array.isArray(page?.rows)) throw new Error("invalid LMArena page");
        rows.push(...page.rows);
      }
    }
  }
  return arenaModels(rows, source, config, date);
}

export function benchmarkCache(config: Config): BenchmarkCache {
  const cached = readCache<BenchmarkCache>(cacheName);
  const maxAge = (config.benchmarks?.max_age_days ?? 7) * 86_400_000;
  return { models: cached?.models ?? {}, sources: Object.fromEntries((config.benchmarks?.sources ?? []).map((source) => {
    const entry = own(cached?.sources, source.id) ?? { fetched_at: null,
      status: source.parse === "artificial-analysis" && !(source as Source).api_key ? "skipped" : "failed" };
    return [source.id, entry.status === "fresh" && entry.fetched_at && Date.now() - Date.parse(entry.fetched_at) > maxAge
      ? { ...entry, status: "stale" } : entry];
  })) };
}

export async function refreshBenchmarks(config: Config): Promise<BenchmarkCache> {
  const previous = readCache<Record<string, Snapshot>>(snapshotsName);
  const date = new Date().toISOString();
  const entries = await Promise.all((config.benchmarks?.sources ?? []).map(async (source: Source): Promise<[string, Snapshot]> => {
    const { id, parse } = source;
    if (parse === "artificial-analysis" && !source.api_key) return [id, { parse, status: { fetched_at: null, status: "skipped" } }];
    try {
      return [id, { parse, status: { fetched_at: date, status: "fresh" }, models: await fetchModels(source, config, date) }];
    } catch (cause) {
      const prior = own(previous ?? undefined, id);
      const stale = prior?.parse === parse && prior.models !== undefined;
      // Do not expose configured URLs, local paths, or API keys in cache diagnostics.
      const code = (cause as NodeJS.ErrnoException)?.code;
      const message = cause instanceof Error ? cause.message : "";
      const error = code && /^[A-Z_]+$/.test(code) ? code : /^HTTP \d{3}$/.test(message) ? message : "benchmark fetch or parse failed";
      return [id, { parse, ...(stale ? { models: prior.models } : {}),
        status: { fetched_at: stale ? prior.status.fetched_at : null, status: stale ? "stale" : "failed", error } }];
    }
  }));
  const models: Models = Object.create(null);
  const primaryPrices = new Set<string>();
  for (const [, snapshot] of entries) {
    if (snapshot.parse === "openrouter") continue;
    for (const [id, value] of Object.entries(snapshot.models ?? {})) {
      if (snapshot.parse === "models-dev") primaryPrices.add(id);
      const model = models[id] ??= {};
      const { scores, tier, ...metadata } = value;
      Object.assign(model, metadata);
      for (const [kind, score] of Object.entries(scores ?? {})) {
        const existing = own(model.scores, kind);
        if (existing && existing.rank <= score.rank) continue;
        (model.scores ??= Object.create(null))[kind] = score;
        const measuredTier = own(tier, kind);
        if (measuredTier !== undefined) (model.tier ??= Object.create(null))[kind] = measuredTier;
      }
    }
  }
  for (const [, snapshot] of entries) {
    if (snapshot.parse !== "openrouter") continue;
    for (const [id, value] of Object.entries(snapshot.models ?? {})) {
      if (!primaryPrices.has(id) && models[id]?.price_out_per_m === undefined) Object.assign(models[id] ??= {}, value);
    }
  }
  const cache = { sources: Object.fromEntries(entries.map(([id, value]) => [id, value.status])), models };
  writeCache(snapshotsName, Object.fromEntries(entries));
  writeCache(cacheName, cache);
  return cache;
}
