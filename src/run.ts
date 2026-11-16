import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { buildAgent, commandArgs, parseOutput } from "./agents.ts";
import type { Config } from "./config.ts";
import { changedFiles, cooldown, gitSnapshot, record, setCooldown } from "./state.ts";

const quotaPattern = /rate.?limit|quota|429|resource.?exhausted|usage limit|too many requests|limit reached/i;

type ProcessResult = {
  stdout: string;
  stderr: string;
  status: number;
  timedOut: boolean;
};

function commandExists(command: string): boolean {
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

export function available(id: string, config: Config): string | null {
  const agent = config.agents[id];
  if (!agent?.enabled) return "disabled";
  if (!commandExists(agent.command)) return `command not found: ${agent.command}`;
  const until = cooldown(id);
  if (until > Date.now() / 1000) {
    const time = new Date(until * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `cooldown until ${time}`;
  }
  if (id === "agy" && agent.quota) return agyQuotaReason(agent.command, agent.quota);
  return null;
}

type UsageBucket = { remaining_fraction: number; reset_time: string };
type UsageGroup = { name: string; buckets?: UsageBucket[] };

// Asks agy for its usage (costs no tokens) and cools it down when the configured group is low.
function agyQuotaReason(command: string, quota: { group: string; min_remaining: number }): string | null {
  const usage = spawnSync(command, ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"], {
    encoding: "utf8",
    timeout: 45_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (usage.status !== 0) return "quota check failed";
  let groups: UsageGroup[];
  try {
    groups = JSON.parse(usage.stdout).command.data.groups;
  } catch {
    return "quota check failed";
  }
  const buckets = groups.filter((group) => group.name === quota.group).flatMap((group) => group.buckets ?? []);
  if (buckets.length === 0) return "quota group not found";
  const lowest = buckets.reduce((min, bucket) => (bucket.remaining_fraction < min.remaining_fraction ? bucket : min));
  if (lowest.remaining_fraction >= quota.min_remaining) return null;
  setCooldown("agy", Math.floor(Date.parse(lowest.reset_time) / 1000));
  const percent = (fraction: number) => Math.floor(fraction * 100);
  return `quota low (${percent(lowest.remaining_fraction)}% < ${percent(quota.min_remaining)}%)`;
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

export async function runAgent(
  id: string,
  config: Config,
  prompt: string,
  requestedModel: string,
  tier: string,
  effort = "",
  role = "",
): Promise<{ ok: boolean; quota: boolean; stderr: string }> {
  const agent = config.agents[id];
  const model = requestedModel || agent.model || "";
  const preamble = agent.prompt_preamble ?? config.prompt_preamble ?? "";
  const task = preamble ? `${preamble}\n\n${prompt}` : prompt;
  const built = buildAgent(id, agent);
  const timeoutSeconds = agent.timeout_seconds ?? 600;
  const started = Date.now();
  const before = gitSnapshot();
  const result = await runProcess(agent.command, commandArgs(id, agent, task, model, effort), timeoutSeconds);
  const seconds = Math.floor((Date.now() - started) / 1000);
  const output = `${result.stdout}${result.stderr}`;
  const answer = parseOutput(built.output, result.stdout);
  const quota = quotaPattern.test(output);

  record(
    id,
    tier,
    model,
    Math.floor(Date.now() / 1000),
    result.status,
    seconds,
    prompt,
    answer || output,
    changedFiles(before, gitSnapshot()),
    role,
  );
  if (quota) setCooldown(id, Math.floor(Date.now() / 1000) + (config.cooldown_seconds ?? 3600));

  if (result.status === 0 && answer.trim()) {
    process.stdout.write(answer.endsWith("\n") ? answer : `${answer}\n`);
    return { ok: true, quota: false, stderr: "" };
  }
  if (result.timedOut) return { ok: false, quota: false, stderr: `${id} timed out after ${timeoutSeconds}s` };
  if (quota) return { ok: false, quota: true, stderr: `${id} hit a quota/rate limit: ${output.trim()}` };
  return { ok: false, quota: false, stderr: `${id} failed (exit ${result.status}): ${output.trim()}` };
}
