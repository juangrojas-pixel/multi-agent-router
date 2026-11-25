import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { buildAgent, commandArgs, parseMeta, parseOutput } from "./agents.ts";
import type { Config } from "./config.ts";
import { hcRun, type ProcessResult } from "./hc.ts";
import { herdrRun } from "./herdr.ts";
import { liveRun } from "./live.ts";
import { changedFiles, cooldown, gitSnapshot, readCache, record, setCooldown } from "./state.ts";

// A refusal of one model (not the agent's quota): that run fails, the agent stays available.
const modelRefusalPattern = /requires usage credits|switch to another model/i;
const quotaPattern = /rate.?limit|quota|429|resource.?exhausted|usage limit|too many requests|limit reached/i;

export function commandExists(command: string): boolean {
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return spawnSync("sh", ["-c", "command -v \"$1\"", "sh", command]).status === 0;
}

// Readiness without asking the agent anything: disabled, command missing or cooling down.
export function localReason(id: string, config: Config): string | null {
  const agent = config.agents[id];
  if (!agent?.enabled) return "disabled";
  if (!commandExists(agent.command)) return `command not found: ${agent.command}`;
  const until = cooldown(id);
  if (until > Date.now() / 1000) {
    const time = new Date(until * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `cooldown until ${time}`;
  }
  return null;
}

export function available(id: string, config: Config): string | null {
  const reason = localReason(id, config);
  if (reason) return reason;
  const agent = config.agents[id];
  if (id === "agy" && agent.quota) return agyQuotaReason(agent.command, agent.quota);
  return null;
}

type UsageBucket = { remaining_fraction: number; reset_time: string };
type UsageGroup = { name: string; buckets?: UsageBucket[] };

// agy's usage report (costs no tokens): its exit status (142 on timeout) and stdout.
export function agyUsage(command: string): { status: number; stdout: string } {
  const usage = spawnSync(command, ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"], {
    encoding: "utf8",
    timeout: 45_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { status: usage.status ?? 142, stdout: usage.stdout ?? "" };
}

// Asks agy for its usage and cools it down when the configured group is low.
function agyQuotaReason(command: string, quota: { group: string; min_remaining: number }): string | null {
  const usage = agyUsage(command);
  if (usage.status !== 0) return "quota check failed";
  // An empty report has no buckets, as jq reads it in the bash router.
  if (!usage.stdout.trim()) return "quota group not found";
  let groups: UsageGroup[];
  try {
    groups = JSON.parse(usage.stdout).command.data.groups;
  } catch {
    return "quota check failed";
  }
  if (!Array.isArray(groups)) return "quota check failed";
  const buckets = groups.filter((group) => group.name === quota.group).flatMap((group) => group.buckets ?? []);
  if (buckets.length === 0) return "quota group not found";
  const lowest = buckets.reduce((min, bucket) => (bucket.remaining_fraction < min.remaining_fraction ? bucket : min));
  if (lowest.remaining_fraction >= quota.min_remaining) return null;
  setCooldown("agy", Math.floor(Date.parse(lowest.reset_time) / 1000));
  const percent = (fraction: number) => Math.floor(fraction * 100);
  return `quota low (${percent(lowest.remaining_fraction)}% < ${percent(quota.min_remaining)}%)`;
}

// Task ID and reason of the current run (`--task`, `--reason`), recorded in runs.jsonl.
let runContext = { task: "", reason: "" };
export function setRunContext(task: string, reason: string): void { runContext = { task, reason }; }

type CatalogCache = { agents?: Record<string, { source?: string; models?: Array<{ id: string; status: string }> }> };

// Why `model` cannot run on agent `id`, or null. The catalog (catalog.json) wins when the agent's
// own CLI listed its models: only usable and unverified models run. When the catalog only
// echoes config (source "config") or has no entry, config `models` decides; an agent without
// `models` accepts any model.
export function modelProblem(id: string, config: Config, model: string): string | null {
  if (!model) return null;
  const entry0 = readCache<CatalogCache>("catalog.json")?.agents?.[id];
  const listed = entry0?.source === "cli" ? entry0.models : undefined;
  if (listed) {
    const entry = listed.find((item) => item.id === model);
    if (!entry) return "not in catalog";
    return entry.status === "usable" || entry.status === "unverified" ? null : entry.status;
  }
  const declared = config.agents[id]?.models;
  if (declared && !declared.includes(model)) return `not in agents.${id}.models`;
  return null;
}

// The header an hc terminal shows while the agent works: who, with which model, on what and why.
function terminalBanner(id: string, model: string, prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  const shown = oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
  return [
    `▶ ${[id, model || "default model", runContext.task ? `task ${runContext.task}` : ""].filter(Boolean).join(" · ")}`,
    ...(runContext.reason ? [`  reason: ${runContext.reason}`] : []),
    `  prompt: ${shown}`,
    "  working… (the answer appears here when the agent finishes)",
    "",
  ].join("\n");
}

// Backend precedence: the --backend flag, then agents.<id>.backend, then backend, then auto.
let backendFlag = "";
export function setBackendFlag(value: string): void { backendFlag = value; }
// With no setting, a router running inside an hc terminal (the Herdr app) uses hc, so every
// agent shows in the app under its orchestrator; anywhere else it uses a subprocess.
function backendFor(id: string, config: Config): string {
  return backendFlag || (config.agents[id]?.backend ?? config.backend ?? (process.env.HC_TERMINAL_SOCKET ? "hc" : "subprocess"));
}

function runProcess(command: string, args: string[], timeoutSeconds: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      env: { ...process.env, ASK_AGENT_DEPTH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch {}
        }, 2_000);
      }
    }, timeoutSeconds * 1_000);

    child.on("error", (error) => { stderr += `${error.message}\n`; });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const status = timedOut ? 142 : code ?? (signal ? 128 : 1);
      resolve({ stdout, stderr, status, timedOut });
    });
  });
}

// `reason` is the short cause shown in role fallback lines: quota, timeout, empty answer or exit N.
// `stderr` is the router's one-line message for -a/-t and parallel runs, worded as the bash router does.
export type RunResult = { ok: boolean; quota: boolean; reason: string; stderr: string; until?: number };

// The last `count` lines of a run's output joined by spaces, as `tail -n COUNT | tr '\n' ' '` gives them.
function lastLines(output: string, count: number): string {
  return output.split("\n").slice(-count).map((line) => `${line} `).join("");
}

// One trailing newline, as the bash router prints an answer captured with $(...).
function withNewline(answer: string): string { return `${answer.replace(/\n+$/, "")}\n`; }

// Runs one agent, records the run and sets its cooldown on a quota error; prints nothing.
async function execute(
  id: string,
  config: Config,
  prompt: string,
  requestedModel: string,
  tier: string,
  effort = "",
  role = "",
): Promise<{ result: RunResult; answer: string }> {
  const agent = config.agents[id];
  const model = requestedModel || agent.model || "";
  // The role preamble adds task instructions after the agent preamble, which keeps the agent's safety rules.
  const preamble = agent.prompt_preamble ?? config.prompt_preamble ?? "";
  const rolePreamble = (role && config.roles?.[role]?.prompt_preamble) || "";
  const head = [preamble, rolePreamble].filter(Boolean).join("\n\n");
  const task = head ? `${head}\n\n${prompt}` : prompt;
  const built = buildAgent(id, agent);
  const timeoutSeconds = agent.timeout_seconds ?? 600;
  const started = Date.now();
  const before = gitSnapshot();
  const args = commandArgs(id, agent, task, model, effort);
  const subprocess = () => runProcess(agent.command, args, timeoutSeconds);
  const hc = (config as Config & { hc_command?: string }).hc_command || "hc";
  const backend = backendFor(id, config);
  const herdr = (config as Config & { herdr_command?: string }).herdr_command || "herdr";
  const hcFallback = () => hcRun(hc, id, agent.command, args, timeoutSeconds, subprocess, runContext.task || model, terminalBanner(id, model, prompt));
  let usedLive = false;
  let result: ProcessResult;
  if (backend === "live") {
    if (agent.live) {
      const liveResult = await liveRun({
        hc,
        agentId: id,
        command: agent.command,
        agent,
        live: agent.live,
        task,
        model,
        effort,
        defaultModelArgs: built.model_args,
        timeoutSeconds,
        label: runContext.task || model,
      });
      if (liveResult) {
        result = liveResult;
        usedLive = true;
      } else {
        result = await subprocess();
      }
    } else {
      process.stderr.write(`[ask-agent] ${id} has no live config, using hc\n`);
      result = await hcFallback();
    }
  } else if (backend === "hc") {
    result = await hcFallback();
  } else if (backend === "herdr") {
    result = await herdrRun({ herdr, agentId: id, model, task: runContext.task, command: agent.command, args, timeoutSeconds }, subprocess);
  } else {
    result = await subprocess();
  }
  const seconds = Math.floor((Date.now() - started) / 1000);
  const output = `${result.stdout}${result.stderr}`;
  // The bash router's view of the output: stdout, a newline, stderr, trailing newlines dropped.
  const combined = `${result.stdout.replace(/\n+$/, "")}\n${result.stderr.replace(/\n+$/, "")}`;
  const outputKind = usedLive ? "text" : built.output;
  const answer = parseOutput(outputKind, result.stdout);
  const meta = parseMeta(outputKind, result.stdout);
  const modelRefused = modelRefusalPattern.test(output);
  const quota = !modelRefused && quotaPattern.test(output);

  record(
    id,
    tier,
    meta.model || model,
    Math.floor(Date.now() / 1000),
    result.status,
    seconds,
    prompt,
    answer || output,
    changedFiles(before, gitSnapshot()),
    role,
    {
      requested_model: requestedModel,
      model_source: meta.model ? "reported" : "requested",
      ...(meta.tokens_in !== undefined ? { tokens_in: meta.tokens_in, tokens_out: meta.tokens_out } : {}),
      ...(runContext.task ? { task_id: runContext.task } : {}),
      ...(runContext.reason ? { reason: runContext.reason } : {}),
      ...(process.env.ASK_AGENT_BATCH_ID ? { batch_id: process.env.ASK_AGENT_BATCH_ID } : {}),
    },
  );
  // The cooldown is written by the caller after it logs the quota error, as the bash router does.
  const until = quota ? Math.floor(Date.now() / 1000) + (config.cooldown_seconds ?? 3600) : undefined;

  if (result.status === 0 && answer.trim()) return { result: { ok: true, quota: false, reason: "", stderr: "" }, answer };
  if (result.timedOut) {
    return { result: { ok: false, quota: false, reason: "timeout", stderr: `${id} timed out after ${timeoutSeconds}s` }, answer };
  }
  if (modelRefused) {
    let message = lastLines(combined, 1).trim();
    try { message = String(JSON.parse(result.stdout).result ?? message); } catch {}
    return { result: { ok: false, quota: false, reason: "model unavailable", stderr: `${id} cannot run model ${model}: ${message}` }, answer };
  }
  if (quota) {
    return { result: { ok: false, quota: true, reason: "quota", stderr: `${id} hit a quota/rate limit: ${lastLines(combined, 3)}`, until }, answer };
  }
  const reason = result.status === 0 ? "empty answer" : `exit ${result.status}`;
  return { result: { ok: false, quota: false, reason, stderr: `${id} failed (exit ${result.status}): ${lastLines(combined, 5)}` }, answer };
}

// Runs one agent and prints its answer on stdout when it succeeds.
export async function runAgent(
  id: string,
  config: Config,
  prompt: string,
  requestedModel: string,
  tier: string,
  effort = "",
  role = "",
): Promise<RunResult> {
  const { result, answer } = await execute(id, config, prompt, requestedModel, tier, effort, role);
  if (result.ok) process.stdout.write(withNewline(answer));
  if (result.until !== undefined) setCooldown(id, result.until);
  return result;
}

function localStamp(seconds: number): string {
  const date = new Date(seconds * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

// One -a/-t or parallel attempt, as the bash router's `attempt`: "using AGENT", the run, its
// failure message, and the end of the cooldown a quota error set. `out` gets the answer.
export async function attempt(
  id: string,
  config: Config,
  prompt: string,
  model: string,
  tier: string,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<boolean> {
  err(`[ask-agent] using ${id}\n`);
  const { result, answer } = await execute(id, config, prompt, model, tier);
  if (result.ok) {
    out(withNewline(answer));
    return true;
  }
  err(`[ask-agent] ${result.stderr}\n`);
  if (result.until !== undefined) {
    setCooldown(id, result.until, err);
    err(`[ask-agent] ${id} cooled down until ${localStamp(result.until)}\n`);
  }
  return false;
}

// Runs every ready agent at once. Prints one `### agent` block per agent, in order, with its
// answer or `_(no answer: ...)_`, and replays each agent's stderr after its block.
export async function runParallel(ids: string[], config: Config, prompt: string, model: string, tier: string): Promise<boolean> {
  const results = await Promise.all(ids.map(async (id) => {
    let out = "";
    let err = "";
    const ok = await attempt(id, config, prompt, model, tier, (text) => { out += text; }, (text) => { err += text; });
    return { id, ok, out, err };
  }));
  let answered = false;
  for (const { id, ok, out, err } of results) {
    if (ok) {
      answered = true;
      process.stdout.write(`### ${id}\n\n${out}\n`);
    } else {
      const last = err.replace(/\n$/, "").split("\n").at(-1) ?? "";
      process.stdout.write(`### ${id}\n\n_(no answer: ${last.replace(/^\[ask-agent\] /, "")})_\n\n`);
    }
    process.stderr.write(err);
  }
  return answered;
}
