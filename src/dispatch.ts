import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import { resolveRole } from "./roles.ts";
import { modelProblem } from "./run.ts";

type DispatchConfig = Config & { client_agents?: unknown };

type DispatchTask = {
  id: string;
  agent?: string;
  role?: string;
  model?: string;
  cwd: string;
  writes?: string[];
  prompt: string;
  client?: boolean;
  fallback?: boolean;
  reason?: string;
};

type TaskOutcome = {
  task: DispatchTask;
  stdout: string;
  stderr: string;
  exit: number;
  seconds: number;
};

export type DispatchReceipt = {
  task_id: string;
  agent: string | null;
  role: string | null;
  model: string | null;
  exit: number;
  seconds: number;
  answer: string;
};

const usage = "usage: ask-agent dispatch [-f FILE | -] [--json]";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function pathsOverlap(a: string, b: string): boolean {
  const na = resolve(a);
  const nb = resolve(b);
  if (na === nb) return true;
  const pa = na.endsWith(sep) ? na : `${na}${sep}`;
  const pb = nb.endsWith(sep) ? nb : `${nb}${sep}`;
  return nb.startsWith(pa) || na.startsWith(pb);
}

function validateBatch(
  config: Config,
  raw: string,
): { ok: true; batchId: string; tasks: DispatchTask[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${(error as Error).message}` };
  }
  if (!isObject(parsed)) return { ok: false, error: "batch: must be a JSON object" };

  if (parsed.batch_id !== undefined && !nonEmptyString(parsed.batch_id)) {
    return { ok: false, error: "batch_id: must be a non-empty string" };
  }
  const batchId = typeof parsed.batch_id === "string"
    ? parsed.batch_id
    : `b-${Math.floor(Date.now() / 1000)}-${process.pid}`;

  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    return { ok: false, error: "tasks: must be a non-empty array" };
  }

  const rawClientAgents = (config as DispatchConfig).client_agents;
  const clientAgents = new Set(
    Array.isArray(rawClientAgents) ? rawClientAgents.filter((id): id is string => typeof id === "string") : [],
  );

  const seenIds = new Set<string>();
  const resolvedWrites: Array<{ index: number; id: string; paths: string[] }> = [];
  const tasks: DispatchTask[] = [];

  for (const [index, item] of parsed.tasks.entries()) {
    const prefix = `tasks[${index}]`;
    if (!isObject(item)) return { ok: false, error: `${prefix}: must be an object` };
    if (!nonEmptyString(item.id)) return { ok: false, error: `${prefix}.id: must be a non-empty string` };
    if (seenIds.has(item.id)) return { ok: false, error: `${prefix}.id: duplicate task id: ${item.id}` };
    seenIds.add(item.id);

    const hasAgent = item.agent !== undefined;
    const hasRole = item.role !== undefined;
    if (hasAgent && hasRole) return { ok: false, error: `${prefix}: set only one of agent or role` };
    if (!hasAgent && !hasRole) return { ok: false, error: `${prefix}: must set either agent or role` };
    if (hasAgent && !nonEmptyString(item.agent)) return { ok: false, error: `${prefix}.agent: must be a non-empty string` };
    if (hasRole && !nonEmptyString(item.role)) return { ok: false, error: `${prefix}.role: must be a non-empty string` };

    if (!nonEmptyString(item.cwd)) return { ok: false, error: `${prefix}.cwd: must be a non-empty string` };
    if (!nonEmptyString(item.prompt)) return { ok: false, error: `${prefix}.prompt: must be a non-empty string` };
    if (item.model !== undefined && !nonEmptyString(item.model)) {
      return { ok: false, error: `${prefix}.model: must be a non-empty string` };
    }
    if (hasRole && item.model !== undefined) {
      return { ok: false, error: `${prefix}.model: cannot set model with role` };
    }
    if (item.writes !== undefined && (!Array.isArray(item.writes) || !item.writes.every(nonEmptyString))) {
      return { ok: false, error: `${prefix}.writes: must be an array of non-empty strings` };
    }
    if (item.client !== undefined && typeof item.client !== "boolean") {
      return { ok: false, error: `${prefix}.client: must be a boolean` };
    }
    if (item.fallback !== undefined && typeof item.fallback !== "boolean") {
      return { ok: false, error: `${prefix}.fallback: must be a boolean` };
    }
    if (item.reason !== undefined && typeof item.reason !== "string") {
      return { ok: false, error: `${prefix}.reason: must be a string` };
    }

    if (hasAgent) {
      const agent = item.agent as string;
      if (!config.agents[agent]) return { ok: false, error: `${prefix}.agent: unknown agent: ${agent}` };
      if (typeof item.model === "string") {
        const problem = modelProblem(agent, config, item.model);
        if (problem) return { ok: false, error: `${prefix}.model: model ${item.model} is not usable for agent ${agent} (${problem})` };
      }
      if (item.client === true && !clientAgents.has(agent)) {
        return { ok: false, error: `${prefix}.client: agent ${agent} is not allowed for client work (policy client_agents)` };
      }
    } else {
      const role = item.role as string;
      let entries;
      try {
        entries = resolveRole(config, role);
      } catch (error) {
        return { ok: false, error: `${prefix}.role: ${(error as Error).message}` };
      }
      if (item.client === true) {
        const disallowed = entries.map((entry) => entry.agent).filter((agent) => !clientAgents.has(agent));
        if (disallowed.length > 0) {
          return {
            ok: false,
            error: `${prefix}.client: role ${role} includes agent(s) not allowed for client work: ${disallowed.join(", ")} (policy client_agents)`,
          };
        }
      }
    }

    const cwd = item.cwd as string;
    const writes = item.writes as string[] | undefined;
    const paths = (writes ?? []).map((entry) => resolve(cwd, entry));
    for (const prev of resolvedWrites) {
      for (const prevPath of prev.paths) {
        for (const nextPath of paths) {
          if (pathsOverlap(prevPath, nextPath)) {
            return {
              ok: false,
              error: `${prefix}.writes: overlaps with tasks[${prev.index}].writes (${prev.id} and ${item.id}: ${prevPath} <-> ${nextPath})`,
            };
          }
        }
      }
    }
    resolvedWrites.push({ index, id: item.id, paths });

    tasks.push({
      id: item.id,
      ...(hasAgent ? { agent: item.agent as string } : { role: item.role as string }),
      ...(typeof item.model === "string" ? { model: item.model } : {}),
      cwd,
      ...(writes ? { writes } : {}),
      prompt: item.prompt,
      ...(item.client !== undefined ? { client: item.client } : {}),
      ...(item.fallback !== undefined ? { fallback: item.fallback } : {}),
      ...(item.reason !== undefined ? { reason: item.reason } : {}),
    });
  }

  return { ok: true, batchId, tasks };
}

function runTask(task: DispatchTask, batchId: string, cliPath: string): Promise<TaskOutcome> {
  const childArgs = task.agent
    ? [
      cliPath,
      "-a", task.agent,
      ...(task.model ? ["-m", task.model] : []),
      "--task", task.id,
      ...(task.reason ? ["--reason", task.reason] : []),
      "-C", task.cwd,
      "--", task.prompt,
    ]
    : [
      cliPath,
      "-r", task.role!,
      "--task", task.id,
      ...(task.reason ? ["--reason", task.reason] : []),
      "-C", task.cwd,
      "--", task.prompt,
    ];

  const env: NodeJS.ProcessEnv = { ...process.env, ASK_AGENT_BATCH_ID: batchId };
  delete env.ASK_AGENT_DEPTH;
  if (task.agent && task.fallback !== true) env.ASK_AGENT_NO_FALLBACK = "1";
  else delete env.ASK_AGENT_NO_FALLBACK;

  const started = Date.now();
  return new Promise((resolveOutcome) => {
    const child = spawn(process.execPath, childArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { stderr += `${error.message}\n`; });
    child.on("close", (code, signal) => {
      const exit = code ?? (signal ? 128 : 1);
      const seconds = Math.floor((Date.now() - started) / 1000);
      resolveOutcome({ task, stdout, stderr, exit, seconds });
    });
  });
}

// `ask-agent dispatch [-f FILE | -] [--json]` (specs/002-agentic-dispatcher/contracts/cli.md).
export async function dispatchCommand(config: Config, args: string[]): Promise<number> {
  function error(message: string): number {
    process.stderr.write(`[ask-agent] dispatch: ${message}\n`);
    return 2;
  }

  let source: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-f") {
      const value = args[++i];
      if (!value || source !== undefined) return error(usage);
      source = value;
    } else if (arg === "-") {
      if (source !== undefined) return error(usage);
      source = "-";
    } else if (arg === "--json") {
      json = true;
    } else {
      return error(usage);
    }
  }

  let raw: string;
  if (source === undefined || source === "-") {
    if (source === undefined && process.stdin.isTTY) return error(usage);
    try {
      raw = readFileSync(0, "utf8");
    } catch (err) {
      return error(`cannot read stdin: ${(err as Error).message}`);
    }
  } else {
    try {
      raw = readFileSync(source, "utf8");
    } catch (err) {
      return error(`cannot read ${source}: ${(err as Error).message}`);
    }
  }

  const validated = validateBatch(config, raw);
  if (!validated.ok) return error(validated.error);

  const { batchId, tasks } = validated;
  const cliPath = resolve(import.meta.dirname, "cli.ts");
  const concurrency = Math.max(1, config.dispatch?.concurrency ?? 3);
  const outcomes = new Array<TaskOutcome>(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const current = nextIndex++;
      if (current >= tasks.length) return;
      outcomes[current] = await runTask(tasks[current], batchId, cliPath);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));

  if (json) {
    const receipts: DispatchReceipt[] = outcomes.map(({ task, stdout, exit, seconds }) => ({
      task_id: task.id,
      agent: task.agent ?? null,
      role: task.role ?? null,
      model: task.model ?? null,
      exit,
      seconds,
      answer: exit === 0 ? stdout.replace(/\n+$/, "") : "",
    }));
    process.stdout.write(`${JSON.stringify(receipts, null, 2)}\n`);
  } else {
    for (const { task, stdout, stderr, exit } of outcomes) {
      const target = task.agent ?? task.role!;
      const modelLabel = task.model || "default";
      if (exit === 0 && stdout.trim()) {
        const body = stdout.endsWith("\n") ? stdout : `${stdout}\n`;
        process.stdout.write(`### ${task.id} (${target}/${modelLabel})\n\n${body}\n`);
      } else {
        const last = stderr.replace(/\n+$/, "").split("\n").at(-1) ?? "";
        const cause = last.replace(/^\[ask-agent\] /, "");
        process.stdout.write(`### ${task.id} (${target}/${modelLabel})\n\n_(no answer: ${cause})_\n\n`);
      }
    }
  }

  for (const outcome of outcomes) {
    if (outcome.stderr) process.stderr.write(outcome.stderr);
  }

  return outcomes.every((outcome) => outcome.exit === 0) ? 0 : 5;
}
