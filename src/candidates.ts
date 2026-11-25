import { benchmarkCache, profileFor } from "./benchmarks.ts";
import { buildCatalog } from "./catalog.ts";
import type { Config } from "./config.ts";

type CandidatesConfig = Config & { client_agents?: unknown };

export type Candidate = {
  agent: string;
  model: string;
  tier: string;
  tier_source: "measured" | "declared";
  est_cost: number | null;
  quota_left: number | null;
  over_ceiling: boolean;
  reason: string;
  efforts?: string[];
};

type Scored = {
  agent: string;
  model: string;
  tier: string;
  tierIndex: number;
  tier_source: "measured" | "declared";
  est_cost: number | null;
  quota_left: number | null;
  over_ceiling: boolean;
  rank: number;
  rating: number;
  agentOrder: number;
  sharesQuotaWith?: string;
  efforts?: string[];
};

const effortOrder = ["low", "medium", "high", "xhigh", "max"];
const effortSuffix = /-(low|medium|high|xhigh|max)$/;

// Effort variants of one model (same agent, tier and cost) become one candidate: the `-high`
// variant when the agent offers it, else the best-ranked one, listing every effort offered.
function groupEfforts(sorted: Scored[]): Scored[] {
  const groups = new Map<string, Scored[]>();
  for (const item of sorted) {
    const base = item.model.replace(effortSuffix, "");
    const key = `${item.agent}\u0000${base}\u0000${item.tier}\u0000${item.est_cost}`;
    const list = groups.get(key);
    if (list) list.push(item); else groups.set(key, [item]);
  }
  const seen = new Set<string>();
  const out: Scored[] = [];
  for (const item of sorted) {
    const base = item.model.replace(effortSuffix, "");
    const key = `${item.agent}\u0000${base}\u0000${item.tier}\u0000${item.est_cost}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const members = groups.get(key)!;
    if (members.length === 1) { out.push(item); continue; }
    const efforts = members.map((m) => effortSuffix.exec(m.model)?.[1] ?? "")
      .sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b));
    const pick = members.find((m) => m.model.endsWith("-high")) ?? item;
    out.push({ ...pick, efforts: efforts.filter(Boolean) });
  }
  return out;
}

const usage = "usage: ask-agent candidates --kind KIND --tier TIER [--size s|m|l] [--client] [-n N] [--json]";

function compareCostAndScore(a: Scored, b: Scored): number {
  const costA = a.est_cost ?? Infinity;
  const costB = b.est_cost ?? Infinity;
  if (costA !== costB) return costA - costB;
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.rating !== b.rating) return b.rating - a.rating;
  return a.agentOrder - b.agentOrder;
}

// `ask-agent candidates --kind KIND --tier TIER [--size s|m|l] [--client] [-n N] [--json]`
// (specs/002-agentic-dispatcher/contracts/cli.md). Returns the exit status.
export async function candidatesCommand(config: Config, args: string[]): Promise<number> {
  function error(message: string): number {
    process.stderr.write(`[ask-agent] error: ${message}\n`);
    return 2;
  }

  let kind: string | undefined;
  let tier: string | undefined;
  let size = "m";
  let clientOnly = false;
  let limit = 5;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--kind":
        kind = args[++i];
        if (!kind || kind.startsWith("-")) return error(usage);
        break;
      case "--tier":
        tier = args[++i];
        if (!tier || tier.startsWith("-")) return error(usage);
        break;
      case "--size":
        size = args[++i] ?? "";
        if (!size || size.startsWith("-")) return error(usage);
        break;
      case "--client":
        clientOnly = true;
        break;
      case "-n": {
        const raw = args[++i] ?? "";
        if (!/^[1-9]\d*$/.test(raw)) return error(usage);
        limit = Number(raw);
        break;
      }
      case "--json":
        json = true;
        break;
      default:
        return error(usage);
    }
  }

  if (!kind || !tier) return error(usage);
  if (!config.kinds?.includes(kind)) return error(`unknown kind: ${kind}`);
  const tiers = config.capability_tiers ?? [];
  if (!tiers.includes(tier)) return error(`unknown tier: ${tier}`);
  if (!config.sizes || !Object.hasOwn(config.sizes, size)) return error(`unknown size: ${size}`);

  let allowedAgents: Set<string> | null = null;
  if (clientOnly) {
    const raw = (config as CandidatesConfig).client_agents;
    const list = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
    if (list.length === 0) {
      process.stderr.write("[ask-agent] no candidate: no agent allowed for client work (policy client_agents)\n");
      return 4;
    }
    allowedAgents = new Set(list);
  }

  const catalog = await buildCatalog(config, { refresh: false });
  const benchmarks = benchmarkCache(config);
  const minTierIndex = tiers.indexOf(tier);
  const budget = config.sizes[size];
  const ceiling = config.cost_ceiling;
  const agentOrder = new Map(Object.keys(config.agents).map((id, i) => [id, i]));

  const capable: Scored[] = [];
  const below: Scored[] = [];

  for (const [agentId, entry] of Object.entries(catalog.agents)) {
    if (allowedAgents && !allowedAgents.has(agentId)) continue;
    const agentCfg = config.agents[agentId];
    for (const model of entry.models) {
      if (model.status !== "usable" && model.status !== "unverified") continue;
      const profile = profileFor(config, benchmarks, model.id);
      const modelTier = profile?.tier && Object.hasOwn(profile.tier, kind) ? profile.tier[kind] : undefined;
      if (!modelTier) continue;
      const tierIndex = tiers.indexOf(modelTier);
      if (tierIndex < 0) continue;

      const rawCost = profile!.price_out_per_m !== undefined ? (profile!.price_out_per_m * budget) / 1e6 : null;
      const est_cost = rawCost === null ? null : Math.round(rawCost * 100) / 100 || 0;
      const over_ceiling = ceiling !== undefined && est_cost !== null && est_cost > ceiling;
      const score = profile!.scores && Object.hasOwn(profile!.scores, kind) ? profile!.scores[kind] : undefined;

      const item: Scored = {
        agent: agentId,
        model: model.id,
        tier: modelTier,
        tierIndex,
        tier_source: profile!.tier_source[kind] ?? "measured",
        est_cost,
        quota_left: model.quota_left ?? null,
        over_ceiling,
        rank: score?.rank ?? Infinity,
        rating: score?.rating ?? -Infinity,
        agentOrder: agentOrder.get(agentId) ?? Infinity,
        sharesQuotaWith: agentCfg?.shares_quota_with,
      };
      if (tierIndex >= minTierIndex) capable.push(item);
      else below.push(item);
    }
  }

  if (capable.length === 0) {
    if (below.length > 0) {
      below.sort((a, b) => (b.tierIndex - a.tierIndex) || compareCostAndScore(a, b));
      const best = below[0];
      process.stderr.write(`[ask-agent] no candidate meets ${kind}>=${tier}; best below: ${best.agent}/${best.model} tier=${best.tier}\n`);
    } else {
      process.stderr.write(`[ask-agent] no candidate meets ${kind}>=${tier}\n`);
    }
    return 4;
  }

  capable.sort(compareCostAndScore);
  capable.splice(0, capable.length, ...groupEfforts(capable));
  const altIndex = capable.findIndex((item) => !item.over_ceiling && item.est_cost !== null);

  const ranked: Candidate[] = capable.map((item, index) => {
    let base: string;
    if (item.over_ceiling) {
      base = `over ceiling ${ceiling}${altIndex >= 0 ? ` -> use #${altIndex + 1}` : ""}`;
    } else if (index === 0) {
      base = "cheapest capable";
    } else if (item.est_cost === null) {
      base = "price unknown";
    } else if (item.est_cost === 0) {
      base = "free";
    } else if (item.tierIndex > minTierIndex) {
      base = `${item.tier} tier`;
    } else {
      base = "capable";
    }
    const reason = item.sharesQuotaWith ? `${base}; shares ${item.sharesQuotaWith} quota` : base;
    return {
      agent: item.agent,
      model: item.model,
      tier: item.tier,
      tier_source: item.tier_source,
      est_cost: item.est_cost,
      quota_left: item.quota_left,
      over_ceiling: item.over_ceiling,
      reason,
      ...(item.efforts ? { efforts: item.efforts } : {}),
    };
  });

  const shown = ranked.slice(0, limit);
  if (json) {
    process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
  } else {
    const lines = shown.map((c, index) => [
      c.over_ceiling ? "!" : String(index + 1),
      `${c.agent}/${c.model}`,
      ...(c.efforts ? [`efforts=${c.efforts.join(",")}`] : []),
      `tier=${c.tier}${c.tier_source === "declared" ? "*" : ""}`,
      `cost=${c.est_cost === null ? "?" : c.est_cost}`,
      ...(c.quota_left === null ? [] : [`quota ${Math.round(c.quota_left * 100)}%`]),
      c.reason,
    ].join("  "));
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return 0;
}
