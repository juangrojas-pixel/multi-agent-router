import { readFileSync, statSync } from "node:fs";
import { configPath, loadConfig, loadPolicy, mergeConfig, validateConfig, type Config } from "./config.ts";
import { guidance } from "./guidance.ts";
import { listRoles, resolveRole, runRole, type RoleEntry } from "./roles.ts";
import { agyUsage, attempt, available, commandExists, modelProblem, runParallel, setBackendFlag, setRunContext } from "./run.ts";
import { clearCooldown, jqText, runsFile, runsTable } from "./state.ts";
import { buildCatalog, catalogCommand } from "./catalog.ts";
import { preflightCommand } from "./preflight.ts";
import { candidatesCommand } from "./candidates.ts";
import { dispatchCommand } from "./dispatch.ts";

const original = process.argv.slice(2);
const NESTED = "error: nested call refused: ask-agent is already running an agent";

function log(message: string): void { process.stderr.write(`[ask-agent] ${message}\n`); }
function fail(message: string): never { log(message); process.exit(2); }

// Commands the bash router owned before the port keep its checks and messages on a missing config.
const bashCommands = ["parallel", "status", "reset", "runs"].includes(original[0] ?? "");
let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (bashCommands) {
    if (process.env.ASK_AGENT_DEPTH) fail(NESTED);
    let isFile = false;
    try { isFile = statSync(configPath()).isFile(); } catch {}
    if (!isFile) fail(`error: config not found: ${configPath()}`);
  }
  fail(`config: ${(error as Error).message}`);
}
const mistake = validateConfig(config);
if (mistake) fail(`config: ${mistake}`);
// The private policy is merged over the repository config; a mistake that appears only after
// the merge is reported with the policy file's path, since that file caused it.
let policy: ReturnType<typeof loadPolicy> = null;
try { policy = loadPolicy(); } catch (error) { fail(`config: ${(error as Error).message}`); }
if (policy) {
  config = mergeConfig(config, policy.data);
  const merged = validateConfig(config);
  if (merged) fail(`config: ${policy.path}: ${merged}`);
}

if (original[0] === "roles") {
  process.stdout.write(listRoles(config));
  process.exit(0);
}
if (original[0] === "guidance") {
  process.stdout.write(guidance(config));
  process.exit(0);
}
// The merged config (agents.json with the private policy over it), for readers outside the
// router such as bin/route-hint and the adapters.
if (original[0] === "config") {
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  process.exit(0);
}
if (process.env.ASK_AGENT_DEPTH) fail(NESTED);

// Readiness of every agent, its tiers, then agy's quota buckets. Exits as the bash router's
// pipeline does: agy's exit status when the usage call fails, 5 when its report is not JSON.
function status(): number {
  for (const id of Object.keys(config.agents)) {
    const tiers = Object.entries(config.tiers ?? {}).filter(([, list]) => list.includes(id)).map(([name]) => name);
    const label = `[${tiers.length ? tiers.join(",") : "explicit only"}]`;
    const reason = available(id, config);
    process.stdout.write(`${id.padEnd(13)} ${label.padEnd(24)} ${reason ? `skip: ${reason}` : "ready"}\n`);
  }
  const agy = config.agents.agy;
  if (agy?.enabled !== true || !commandExists(agy.command)) return 0;
  process.stdout.write("\nagy quota:\n");
  const usage = agyUsage(agy.command);
  if (usage.status !== 0) return usage.status;
  if (!usage.stdout.trim()) return 0;
  let groups: unknown;
  try { groups = JSON.parse(usage.stdout)?.command?.data?.groups; } catch { return 5; }
  if (!Array.isArray(groups)) return 5;
  for (const group of groups) {
    if (!Array.isArray(group?.buckets)) return 5;
    for (const bucket of group.buckets) {
      if (typeof bucket?.remaining_fraction !== "number") return 5;
      const percent = Math.floor(bucket.remaining_fraction * 100);
      process.stdout.write(`  ${jqText(group.name)} / ${jqText(bucket.window)}: ${percent}% (reset ${jqText(bucket.reset_time)})\n`);
    }
  }
  return 0;
}

if (original[0] === "status") process.exit(status());
if (original[0] === "catalog") process.exit(await catalogCommand(config, original.slice(1)));
if (original[0] === "preflight") process.exit(await preflightCommand(config, original.slice(1)));
if (original[0] === "candidates") process.exit(await candidatesCommand(config, original.slice(1)));
if (original[0] === "dispatch") process.exit(await dispatchCommand(config, original.slice(1)));
if (original[0] === "reset") {
  const agent = original[1] ?? "";
  clearCooldown(agent);
  log(`cooldown cleared ${agent || "for all agents"}`);
  process.exit(0);
}
if (original[0] === "runs") {
  const usage = "error: usage: ask-agent runs [N] [-a AGENT]";
  let limit = 20;
  let agent = "";
  for (let index = 1; index < original.length; index += 1) {
    const argument = original[index];
    if (argument === "-a" || argument === "--agent") {
      agent = original[index + 1] ?? "";
      if (!agent) fail(usage);
      index += 1;
    } else if (/^[0-9]+$/.test(argument)) limit = Number(argument);
    else fail(usage);
  }
  const table = runsTable(limit, agent);
  if (table === null) log(`no runs recorded yet (${runsFile()})`);
  else process.stdout.write(table);
  process.exit(0);
}

const parallel = original[0] === "parallel";
const args = parallel ? original.slice(1) : original;

let tier = "";
let agents = "";
let role = "";
let model = "";
let prompt = "";
let dir = "";
let taskId = "";
let reason = "";

function optionValue(index: number): string {
  const value = args[index + 1];
  if (!value) fail(`error: unknown option: ${args[index]}`);
  return value;
}

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--") {
    prompt = args.slice(index + 1).join(" ");
    break;
  }
  if (argument === "-t" || argument === "--tier") tier = optionValue(index++);
  else if (argument === "-a" || argument === "--agent") agents = optionValue(index++);
  else if (!parallel && (argument === "-r" || argument === "--role")) role = optionValue(index++);
  else if (argument === "-m" || argument === "--model") model = optionValue(index++);
  else if (argument === "-C" || argument === "--cwd") dir = optionValue(index++);
  else if (argument === "--task") taskId = optionValue(index++);
  else if (argument === "--reason") reason = optionValue(index++);
  else if (argument === "--backend") {
    const backend = args[++index] ?? "";
    if (backend !== "hc" && backend !== "herdr" && backend !== "live" && backend !== "subprocess") fail(`error: unknown backend: ${backend} (use hc, herdr, live or subprocess)`);
    setBackendFlag(backend);
  } else if (argument === "-h" || argument === "--help") {
    process.stdout.write([
      "ask-agent: route a prompt to external agent CLIs (codex/pi, agy, opencode,",
      "gentle-shell) by tier, with proactive quota checks and reactive fallback.",
      "",
      "Usage:",
      "  ask-agent [-t TIER | -a AGENT] [-m MODEL] [-C DIR] [PROMPT]   first ready agent answers",
      "    --task ID --reason TEXT                                     recorded with the run in runs.jsonl",
      "  ask-agent -r ROLE [-C DIR] [PROMPT]                           run as a role from agents.json",
      "  ask-agent roles                                               role entries: agent, model, effort, ready",
      "  ask-agent guidance                                            routing guidance for the orchestrator",
      "  ask-agent config                                              merged config (agents.json + private policy) as JSON",
      "  ask-agent parallel [-t TIER | -a A,B] [-C DIR] [PROMPT]       every ready agent answers",
      "  ask-agent status                                              readiness, tiers, agy quota",
      "  ask-agent catalog [-a AGENT] [--refresh] [--json]             usable models per agent, with status and quota",
      "  ask-agent preflight [--json]                                  versions, quotas, models, data freshness (reports only)",
      "  ask-agent candidates --kind K --tier T [--size s|m|l] [--client] [-n N] [--json]  agent/model pairs, cheapest capable first",
      "  ask-agent dispatch [-f FILE | -] [--json]                     run a batch of distinct tasks in parallel, one receipt each",
      "  ask-agent reset [AGENT]                                       clear cooldowns",
      "  ask-agent runs [N] [-a AGENT]                                 run history (runs.jsonl)",
      "Tiers: think | execute | draft (see agents.json). Prompt is read from stdin if omitted.",
      "-r/--role ROLE: run on the role's agents in order, with the role's model and effort;",
      "  cannot be combined with -a, -t or -m.",
      "Agent keys: args, model_args, effort_args, output, models, effort_levels (see README).",
      "The config is checked before any command; a mistake exits 2 naming its key.",
      "--backend hc|herdr|live|subprocess: run agents in live hc terminals, in Herdr panes, as interactive TUIs (live) or as plain subprocesses.",
      "",
    ].join("\n"));
    process.exit(0);
  } else if (argument.startsWith("-")) fail(`error: unknown option: ${argument}`);
  else {
    prompt = args.slice(index).join(" ");
    break;
  }
}

if (role && (tier || agents)) fail("use only one of -r, -a, -t");
if (role && model) fail("use -r without -m: the model comes from the role");
if (tier && agents) fail("error: use either -t or -a, not both");
// parallel checks in the bash router's order: agents and tier before the prompt, the directory last.
if (parallel) {
  for (const id of agents.split(",").filter(Boolean)) if (!config.agents[id]) fail(`error: unknown agent: ${id}`);
  if (tier && !config.tiers?.[tier]) fail(`error: unknown tier: ${tier}`);
}
let roleEntries: RoleEntry[] = [];
if (role) {
  try { roleEntries = resolveRole(config, role); } catch (error) { fail((error as Error).message); }
}
function changeDir(): void {
  if (!dir) return;
  try { process.chdir(dir); } catch { fail(`error: cannot cd to ${dir}`); }
}
if (!parallel) changeDir();
if (!prompt) {
  if (process.stdin.isTTY) fail("error: no prompt given");
  // Trailing newlines are dropped, as bash's $(cat) does in the bash router.
  prompt = readFileSync(0, "utf8").replace(/\n+$/, "");
}
if (!prompt.trim()) fail("error: empty prompt");
if (parallel) changeDir();

setRunContext(taskId, reason);
if (role) process.exit((await runRole(config, role, roleEntries, prompt)) ? 0 : 2);

let candidates: string[];
if (agents) {
  const named = parallel ? agents.split(",").filter(Boolean) : agents.split(",");
  for (const id of named) if (!config.agents[id]) fail(`error: unknown agent: ${id}`);
  for (const id of named) {
    let problem = modelProblem(id, config, model);
    // A model released after the last catalog refresh: list that agent again once before refusing.
    if (problem === "not in catalog" && config.agents[id].list_models) {
      await buildCatalog(config, { refresh: true, agent: id, keepCached: true });
      problem = modelProblem(id, config, model);
      if (!problem) log(`catalog refreshed for ${id}: ${model} is usable`);
    }
    if (problem) fail(`model ${model} is not usable for agent ${id} (${problem})`);
  }
  candidates = [];
  for (const id of named) {
    // ASK_AGENT_NO_FALLBACK=1 (set by dispatch for tasks without `fallback: true`) runs only the named agent.
    const fallbacks = process.env.ASK_AGENT_NO_FALLBACK ? [] : (config.agents[id].fallback ?? []);
    for (const candidate of [id, ...fallbacks]) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
} else {
  const selectedTier = tier || config.default_tier || "execute";
  if (!config.tiers?.[selectedTier]) fail(`error: unknown tier: ${selectedTier}`);
  candidates = config.tiers[selectedTier];
}

if (candidates.length === 0) process.exit(2);
if (parallel) {
  const ready = candidates.filter((id) => {
    const reason = available(id, config);
    if (reason) log(`skip ${id}: ${reason}`);
    return !reason;
  });
  if (ready.length === 0) fail(`error: no agent ready (checked: ${candidates.join(" ")})`);
  if (!(await runParallel(ready, config, prompt, model, tier))) fail("error: no agent could answer");
  process.exit(0);
}
const namedAgents = agents ? agents.split(",") : [];
for (const id of candidates) {
  // A fallback the requested model cannot run on is skipped; named agents were checked above.
  const modelReason = agents && !namedAgents.includes(id) ? modelProblem(id, config, model) : null;
  if (modelReason) {
    log(`skip ${id}: model ${model} is not usable (${modelReason})`);
    continue;
  }
  const reason = available(id, config);
  if (reason) {
    log(`skip ${id}: ${reason}`);
    continue;
  }
  const answered = await attempt(id, config, prompt, model, tier,
    (text) => { process.stdout.write(text); }, (text) => { process.stderr.write(text); });
  if (answered) process.exit(0);
}
fail(`error: no agent could answer (tried: ${candidates.join(" ")})`);
