import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Agent, LiveConfig } from "./config.ts";
import { commandArgs } from "./agents.ts";
import { address, capture, terminalName, type ProcessResult } from "./hc.ts";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function note(message: string): void { process.stderr.write(`[ask-agent] ${message}\n`); }

// Resolves `command` using `command -v` semantics against the router's PATH so hc's daemon
// (whose PATH may lack user bin directories) can launch it by absolute path.
export function resolveCommandPath(command: string): string {
  if (command.includes("/")) return resolve(command);
  const found = spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], { encoding: "utf8" });
  const path = (found.stdout ?? "").trim();
  return path ? resolve(path) : command;
}

export function liveArgs(agent: Agent, live: LiveConfig, model: string, effort = "", fallbackModelArgs?: string[]): string[] {
  return commandArgs("", {
    ...agent,
    args: live.args,
    model_args: live.model_args ?? fallbackModelArgs ?? agent.model_args,
    output: agent.output ?? "text",
  }, "{prompt}", model, effort);
}

type GetInfo = { live: boolean; exitCode: number; statusState: string; statusMsg: string };
function parseGet(output: string): GetInfo | null {
  try {
    const data = JSON.parse(output);
    if (typeof data?.state !== "string" || !data.state) return null;
    const status = data?.status && typeof data.status === "object" ? data.status : {};
    return {
      live: data?.state === "live",
      exitCode: typeof data?.exit_code === "number" ? data.exit_code : 1,
      statusState: typeof status.state === "string" ? status.state : "",
      statusMsg: typeof status.msg === "string" ? status.msg : "",
    };
  } catch {
    return null;
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
    "--", "env", "ASK_AGENT_DEPTH=1", absCommand, ...args,
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
  let worked = false;
  let lastMsg = "";
  let needWait = false;
  let blockedNoted = "";

  function readAnswer(): string | undefined {
    return existsSync(answerFile) ? readFileSync(answerFile, "utf8") : undefined;
  }

  function finishAnswer(stdout: string): ProcessResult {
    rmSync(dir, { recursive: true, force: true });
    if (!stdout.trim()) {
      return { stdout: "", stderr: `${agentId} did not provide a non-empty answer\n`, status: 1, timedOut: false };
    }
    note(`${agentId} answered; its terminal ${name} stays open in the Herdr app`);
    return { stdout, stderr: "", status: 0, timedOut: false };
  }

  async function finishTimeout(): Promise<ProcessResult> {
    const interrupted = await capture(hc, ["interrupt", addr, "--timeout", "2"]);
    if (interrupted.status !== 0) {
      await capture(hc, ["kill", addr]);
    } else {
      const after = await capture(hc, ["get", addr, "--json"]);
      const info = after.status === 0 ? parseGet(after.output) : null;
      if (!info || (info.live && info.statusState === "working")) {
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
    const info = got.status === 0 ? parseGet(got.output) : null;
    if (!info) {
      needWait = true;
      continue;
    }
    const statusState = info.statusState || waitStatus;
    if (info.statusMsg) lastMsg = info.statusMsg;

    if (!info.live) {
      const stdout = sent ? readAnswer() : undefined;
      if (stdout?.trim()) return finishAnswer(stdout);
      rmSync(dir, { recursive: true, force: true });
      const msg = lastMsg || `hc terminal ${name} ended unexpectedly (exit ${info.exitCode})`;
      return { stdout: "", stderr: `${msg}\n`, status: info.exitCode || 1, timedOut: false };
    }

    if (statusState === "blocked") {
      const msg = info.statusMsg;
      const matchIndex = dialogs.findIndex((dialog) => msg.includes(dialog.match));
      if (!sent && matchIndex !== -1 && dialogCounts[matchIndex] < 3) {
        dialogCounts[matchIndex] += 1;
        await capture(hc, ["keys", addr, ...dialogs[matchIndex].keys]);
        needWait = true;
        continue;
      }
      if (msg !== blockedNoted) note(`${agentId} is waiting for you in hc terminal ${name}: ${msg}`);
      blockedNoted = msg;
      if (sent) {
        // The task is running: let the user answer in the app. The deadline still
        // bounds the wait, and finishTimeout stops the task, so nothing is orphaned.
        needWait = true;
        continue;
      }
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

    if (sent) {
      if (statusState === "working") worked = true;
      if (statusState === "done" || statusState === "idle") {
        const stdout = readAnswer();
        // An idle snapshot can be left over from before send. A real answer or
        // an observed working state distinguishes it from completion.
        if (statusState === "done" || worked || stdout?.trim()) {
          if (stdout !== undefined) return finishAnswer(stdout);
          const msg = info.statusMsg.trim();
          if (msg && msg !== "DONE") {
            note(`${agentId} did not write the answer file; using its last status message`);
            return finishAnswer(info.statusMsg);
          }
          return finishAnswer("");
        }
      }
    }

    needWait = true;
  }
}
