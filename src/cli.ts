import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.ts";
import { resolveRole, runRole, type RoleEntry } from "./roles.ts";
import { available, runAgent } from "./run.ts";

const original = process.argv.slice(2);
const bashRouter = fileURLToPath(new URL("../bin/ask-agent", import.meta.url));

function log(message: string): void { process.stderr.write(`[ask-agent] ${message}\n`); }
function fail(message: string): never { log(message); process.exit(2); }
function handoff(): never {
  const result = spawnSync(bashRouter, original, { stdio: "inherit" });
  process.exit(result.status ?? 2);
}

if (["parallel", "status", "reset", "runs"].includes(original[0] ?? "")) handoff();
if (original.some((value, index) => value === "--backend" && original[index + 1] === "hc")) handoff();
if (process.env.ASK_AGENT_DEPTH) fail("error: nested call refused: ask-agent is already running an agent");

let config: Config;
try { config = loadConfig(); } catch (error) { fail(`config: ${(error as Error).message}`); }

function selectedAgents(args: string[], value: Config): string[] {
  const roleIndex = args.findIndex((arg) => arg === "-r" || arg === "--role");
  if (roleIndex >= 0) return (value.roles?.[args[roleIndex + 1] ?? ""]?.agents ?? []).map((item) => (typeof item === "string" ? item : item.agent));
  const agentIndex = args.findIndex((arg) => arg === "-a" || arg === "--agent");
  if (agentIndex >= 0) return (args[agentIndex + 1] ?? "").split(",").filter(Boolean);
  const tierIndex = args.findIndex((arg) => arg === "-t" || arg === "--tier");
  const tier = tierIndex >= 0 ? args[tierIndex + 1] : value.default_tier || "execute";
  return value.tiers?.[tier ?? ""] ?? [];
}

const explicitSubprocess = original.some((value, index) => value === "--backend" && original[index + 1] === "subprocess");
if (!explicitSubprocess && (config.backend === "hc" || selectedAgents(original, config).some((id) => config.agents[id]?.backend === "hc"))) handoff();

let tier = "";
let agents = "";
let role = "";
let model = "";
let prompt = "";
let dir = "";

function optionValue(index: number): string {
  const value = original[index + 1];
  if (!value) fail(`error: unknown option: ${original[index]}`);
  return value;
}

for (let index = 0; index < original.length; index += 1) {
  const argument = original[index];
  if (argument === "--") {
    prompt = original.slice(index + 1).join(" ");
    break;
  }
  if (argument === "-t" || argument === "--tier") tier = optionValue(index++);
  else if (argument === "-a" || argument === "--agent") agents = optionValue(index++);
  else if (argument === "-r" || argument === "--role") role = optionValue(index++);
  else if (argument === "-m" || argument === "--model") model = optionValue(index++);
  else if (argument === "-C" || argument === "--cwd") dir = optionValue(index++);
  else if (argument === "--backend") {
    const backend = optionValue(index++);
    if (backend !== "subprocess") fail(`error: unknown backend: ${backend} (use hc or subprocess)`);
  } else if (argument === "-h" || argument === "--help") {
    process.stdout.write([
      "ask-agent: route a prompt to external agent CLIs (codex/pi, agy, opencode,",
      "gentle-shell) by tier, with proactive quota checks and reactive fallback.",
      "",
      "Usage:",
      "  ask-agent [-t TIER | -a AGENT] [-m MODEL] [-C DIR] [PROMPT]   first ready agent answers",
      "  ask-agent -r ROLE [-C DIR] [PROMPT]                           run as a role from agents.json",
      "  ask-agent parallel [-t TIER | -a A,B] [-C DIR] [PROMPT]       every ready agent answers",
      "  ask-agent status                                              readiness, tiers, agy quota",
      "  ask-agent reset [AGENT]                                       clear cooldowns",
      "  ask-agent runs [N] [-a AGENT]                                 run history (runs.jsonl)",
      "Tiers: think | execute | draft (see agents.json). Prompt is read from stdin if omitted.",
      "-r/--role ROLE: run on the role's agents in order, with the role's model and effort;",
      "  cannot be combined with -a, -t or -m.",
      "--backend hc|subprocess: run agents in live hc terminals or as plain subprocesses.",
      "",
    ].join("\n"));
    process.exit(0);
  } else if (argument.startsWith("-")) fail(`error: unknown option: ${argument}`);
  else {
    prompt = original.slice(index).join(" ");
    break;
  }
}

if (role && (tier || agents)) fail("use only one of -r, -a, -t");
if (role && model) fail("use -r without -m: the model comes from the role");
if (tier && agents) fail("error: use either -t or -a, not both");
let roleEntries: RoleEntry[] = [];
if (role) {
  try { roleEntries = resolveRole(config, role); } catch (error) { fail((error as Error).message); }
}
if (dir) {
  try { process.chdir(dir); } catch { fail(`error: cannot cd to ${dir}`); }
}
if (!prompt) {
  if (process.stdin.isTTY) fail("error: no prompt given");
  prompt = readFileSync(0, "utf8");
}
if (!prompt.trim()) fail("error: empty prompt");

if (role) process.exit((await runRole(config, role, roleEntries, prompt)) ? 0 : 2);

let candidates: string[];
if (agents) {
  const named = agents.split(",");
  for (const id of named) if (!config.agents[id]) fail(`error: unknown agent: ${id}`);
  candidates = [];
  for (const id of named) {
    for (const candidate of [id, ...(config.agents[id].fallback ?? [])]) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
} else {
  const selectedTier = tier || config.default_tier || "execute";
  if (!config.tiers?.[selectedTier]) fail(`error: unknown tier: ${selectedTier}`);
  candidates = config.tiers[selectedTier];
}

if (candidates.length === 0) process.exit(2);
for (const id of candidates) {
  const reason = available(id, config);
  if (reason) {
    log(`skip ${id}: ${reason}`);
    continue;
  }
  log(`using ${id}`);
  const result = await runAgent(id, config, prompt, model, tier);
  if (result.ok) process.exit(0);
  log(result.stderr);
}
fail(`error: no agent could answer (tried: ${candidates.join(" ")})`);
