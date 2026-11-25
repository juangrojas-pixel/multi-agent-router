import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Agent, LiveConfig } from "./config.ts";
import { terminalName, type ProcessResult } from "./hc.ts";

type Captured = { output: string; status: number | null; error: string };

function capture(command: string, args: string[]): Promise<Captured> {
  return new Promise((resolveCapture) => {
    let output = "";
    let error = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.on("error", (failure: NodeJS.ErrnoException) => {
      if (failure.code === "ENOENT") error = command.includes("/") ? `${command}: No such file or directory` : `${command}: command not found`;
      else if (failure.code === "EACCES") error = `${command}: Permission denied`;
      else error = `${command}: ${failure.message}`;
    });
    child.on("close", (status) => resolveCapture({ output: error ? `${output}${error}\n` : output, status, error }));
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function note(message: string): void { process.stderr.write(`[ask-agent] ${message}\n`); }

// `<agent>-<task or model>-<pid>`: matches hcRun naming, <= 32 chars, unique among live terminals.

// Resolves `command` using `command -v` semantics against the router's PATH so hc's daemon
// (whose PATH may lack user bin directories) can launch it by absolute path.
export function resolveCommandPath(command: string): string {
  if (command.includes("/")) return resolve(command);
  const found = spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], { encoding: "utf8" });
  const path = (found.stdout ?? "").trim();
  return path ? resolve(path) : command;
}

export function liveArgs(agent: Agent, live: LiveConfig, model: string, effort = "", fallbackModelArgs?: string[]): string[] {
  const timeout = String(agent.timeout_seconds ?? 600);
  const modelArgs = live.model_args ?? fallbackModelArgs ?? agent.model_args;
  const fragments: Record<string, string[]> = {
    "{model_args}": model && modelArgs ? modelArgs.map((item) => item.replaceAll("{model}", model)) : [],
    "{effort_args}": effort && agent.effort_args ? agent.effort_args.map((item) => item.replaceAll("{effort}", effort)) : [],
    "{extra_args}": agent.extra_args ?? [],
  };
  const out: string[] = [];
  for (const part of live.args) {
    if (part in fragments) out.push(...fragments[part]);
    else out.push(part.replaceAll("{timeout}", timeout).replaceAll("{model}", model));
  }
  return out;
}

function address(output: string): string {
  try {
    const value = JSON.parse(output).address;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

type GetInfo = { live: boolean; exitCode: number; statusState: string; statusMsg: string };
function parseGet(output: string): GetInfo {
  try {
    const data = JSON.parse(output);
    const status = data?.status && typeof data.status === "object" ? data.status : {};
    return {
      live: data?.state === "live",
      exitCode: typeof data?.exit_code === "number" ? data.exit_code : 1,
      statusState: typeof status.state === "string" ? status.state : "",
      statusMsg: typeof status.msg === "string" ? status.msg : "",
    };
  } catch {
    return { live: false, exitCode: 1, statusState: "", statusMsg: "" };
  }
}

type WaitInfo = { status: string; reason: string };
function parseWait(output: string): WaitInfo {
  try {
    const data = JSON.parse(output);
    return {
      status: typeof data?.status === "string" ? data.status : "",
      reason: typeof data?.reason === "string" ? data.reason : "",
    };
  } catch {
    return { status: "", reason: "" };
  }
}

export type LiveRun = {
  hc: string;
  agentId: string;
  command: string;
  agent: Agent;
  live: LiveConfig;
  task: string;
  model: string;
  effort?: string;
  defaultModelArgs?: string[];
  timeoutSeconds: number;
  label?: string;
};

// Runs an agent in its interactive TUI inside an hc terminal under the caller.
// Answers only configured startup dialogs (at most 3 times each), sends the task on first idle,
// reads the final answer from a temporary answer file, and leaves the terminal open for the user.
// Returns null when hc cannot start the terminal so the caller can fall back to subprocess.
export async function liveRun(run: LiveRun): Promise<ProcessResult | null> {
  const { hc, agentId, command, agent, live, task, model, effort = "", defaultModelArgs, timeoutSeconds, label = "" } = run;
  const name = terminalName(agentId, label);
  const absCommand = resolveCommandPath(command);
  const args = liveArgs(agent, live, model, effort, defaultModelArgs);
  const dir = mkdtempSync(join(tmpdir(), "ask-agent-live-"));
  const answerFile = join(dir, "answer.txt");

  const started = await capture(hc, [
    "run", "--bg", "--json", "--no-notify",
    "--name", name,
    "--cwd", process.cwd(),
    "--label", "ask-agent=1",
    "--", absCommand, ...args,
  ]);
  const addr = address(started.output);
  if (!addr) {
    const lines = started.output.replace(/\n+$/, "").split("\n");
    note(`hc unavailable (${lines.at(-1) ?? ""}), falling back to subprocess`);
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  note(`running ${agentId} live in hc terminal ${name}`);

  const deadline = Date.now() + timeoutSeconds * 1000;
  const dialogs = live.dialogs ?? [];
  const dialogCounts = dialogs.map(() => 0);
  let sent = false;
  let lastMsg = "";
  let needWait = false;

  async function finishTimeout(): Promise<ProcessResult> {
    const interrupted = await capture(hc, ["interrupt", addr, "--timeout", "2"]);
    if (interrupted.status !== 0) {
      await capture(hc, ["kill", addr]);
    } else {
      const after = await capture(hc, ["get", addr, "--json"]);
      const info = parseGet(after.output);
      if (info.live && info.statusState === "working") {
        await capture(hc, ["kill", addr]);
      }
    }
    rmSync(dir, { recursive: true, force: true });
    return { stdout: "", stderr: "", status: 142, timedOut: true };
  }

  while (true) {
    if (Date.now() >= deadline) return finishTimeout();

    let waitStatus = "";
    if (needWait) {
      const leftSec = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      const beforeWait = Date.now();
      const waited = await capture(hc, ["wait", addr, "--json", "--timeout", String(Math.min(leftSec, 30))]);
      const waitInfo = parseWait(waited.output);
      waitStatus = waitInfo.status;
      if (Date.now() >= deadline) return finishTimeout();
      if (waitInfo.reason !== "status" && Date.now() - beforeWait < 200) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return finishTimeout();
        await sleep(Math.min(200, remaining));
      }
      needWait = false;
    }

    const got = await capture(hc, ["get", addr, "--json"]);
    const info = parseGet(got.output);
    const statusState = info.statusState || waitStatus;
    if (info.statusMsg) lastMsg = info.statusMsg;

    if (!info.live) {
      if (sent && existsSync(answerFile)) {
        const stdout = readFileSync(answerFile, "utf8");
        note(`${agentId} answered; its terminal ${name} stays open in the Herdr app`);
        rmSync(dir, { recursive: true, force: true });
        return { stdout, stderr: "", status: 0, timedOut: false };
      }
      rmSync(dir, { recursive: true, force: true });
      const msg = lastMsg || `hc terminal ${name} ended unexpectedly (exit ${info.exitCode})`;
      return { stdout: "", stderr: `${msg}\n`, status: info.exitCode || 1, timedOut: false };
    }

    if (statusState === "blocked") {
      const msg = info.statusMsg;
      const matchIndex = dialogs.findIndex((dialog) => msg.includes(dialog.match));
      if (matchIndex !== -1 && dialogCounts[matchIndex] < 3) {
        dialogCounts[matchIndex] += 1;
        await capture(hc, ["keys", addr, ...dialogs[matchIndex].keys]);
        needWait = true;
        continue;
      }
      note(`${agentId} is waiting for you in hc terminal ${name}: ${msg}`);
      rmSync(dir, { recursive: true, force: true });
      return { stdout: "", stderr: msg ? `${msg}\n` : "blocked\n", status: 2, timedOut: false };
    }

    if (statusState === "error") {
      const msg = info.statusMsg || lastMsg || "agent error";
      rmSync(dir, { recursive: true, force: true });
      return { stdout: "", stderr: `${msg}\n`, status: 1, timedOut: false };
    }

    if (!sent && statusState === "idle") {
      sent = true;
      const payload = `${task}\n\nWhen you finish, write your complete final answer to ${answerFile} and then reply with exactly: DONE`;
      const sentResult = await capture(hc, ["send", addr, payload]);
      if (sentResult.status !== 0) {
        rmSync(dir, { recursive: true, force: true });
        return { stdout: "", stderr: sentResult.output || "hc send failed\n", status: 1, timedOut: false };
      }
      needWait = true;
      continue;
    }

    if (sent && (statusState === "done" || statusState === "idle")) {
      let stdout = "";
      if (existsSync(answerFile)) {
        stdout = readFileSync(answerFile, "utf8");
      } else {
        note(`${agentId} did not write the answer file; using its last status message`);
        stdout = info.statusMsg || lastMsg;
      }
      note(`${agentId} answered; its terminal ${name} stays open in the Herdr app`);
      rmSync(dir, { recursive: true, force: true });
      return { stdout, stderr: "", status: 0, timedOut: false };
    }

    needWait = true;
  }
}
