import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv } from "./agents.ts";
import type { ProcessResult } from "./hc.ts";

// Runs inside the Herdr pane: restores the router's environment, runs the agent with the
// arguments stored NUL-separated in "$d/argv" (the prompt never goes through the pane's command
// line), shows its output live and keeps stdout, stderr and the exit code for the router.
const runScript = `d="$1"
printf '%s\\n' "$$" >"$d/pid"
while IFS= read -r -d '' kv; do export "$kv" 2>/dev/null; done <"$d/env"
args=()
while IFS= read -r -d '' a; do args+=("$a"); done <"$d/argv"
"\${args[@]}" </dev/null 2> >(tee "$d/err" >&2) | tee "$d/out"
rc=\${PIPESTATUS[0]}
wait $! 2>/dev/null
printf '%s\\n' "$rc" >"$d/rc.tmp" && mv "$d/rc.tmp" "$d/rc"
`;

type Captured = { output: string; status: number | null };

function capture(command: string, args: string[], timeoutMs = 10_000): Promise<Captured> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      output += `${command}: timed out after ${Math.ceil(timeoutMs / 1000)}s\n`;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        killTimer = setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch {}
        }, 500);
      }
    }, timeoutMs);
    child.on("error", (failure) => { output += `${command}: ${failure.message}\n`; });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ output, status: timedOut ? 142 : status });
    });
  });
}

function readProcStat(pid: number): { state: string; pgrp: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return null;
    const fields = stat.slice(close + 2).split(" ");
    return { state: fields[0] ?? "", pgrp: Number(fields[2]) };
  } catch {
    return null;
  }
}

function isTargetAlive(target: number): boolean {
  if (target > 0) {
    const stat = readProcStat(target);
    if (stat) return stat.state !== "Z" && stat.state !== "X";
  }
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function note(message: string): void { process.stderr.write(`[ask-agent] ${message}\n`); }

function readText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function paneId(output: string): string {
  try {
    const value = JSON.parse(output)?.result?.pane?.pane_id;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export type HerdrRun = {
  herdr: string; agentId: string; model: string; task: string;
  command: string; args: string[]; timeoutSeconds: number;
};

// Runs `command args` in a sibling Herdr pane that shows the agent live and appears in Herdr's
// sidebar (labeled, reported working). The result matches the subprocess backend; the pane
// closes after success and stays open after a failure. Outside Herdr, or when the split is
// refused, `fallback` (the subprocess backend) runs instead.
export async function herdrRun(run: HerdrRun, fallback: () => Promise<ProcessResult>): Promise<ProcessResult> {
  if (process.env.HERDR_ENV !== "1") {
    note("herdr unavailable (not inside a Herdr pane), falling back to subprocess");
    return fallback();
  }
  const { herdr, agentId } = run;
  const controlTimeoutMs = Math.min(10_000, Math.max(1_000, run.timeoutSeconds * 1_000));
  const runHerdr = (args: string[]) => capture(herdr, args, controlTimeoutMs);
  const split = await runHerdr(["pane", "split", "--current", "--direction", "right", "--cwd", process.cwd(), "--no-focus"]);
  const pane = split.status === 0 ? paneId(split.output) : "";
  if (!pane) {
    const lines = split.output.replace(/\n+$/, "").split("\n");
    note(`herdr unavailable (${lines.at(-1) ?? ""}), falling back to subprocess`);
    return fallback();
  }
  const label = [agentId, run.task || run.model].filter(Boolean).join(" ");
  await runHerdr(["pane", "rename", pane, label]);
  const report = (state: string, message: string) => runHerdr([
    "pane", "report-agent", pane, "--source", "ask-agent", "--agent", agentId, "--state", state, "--message", message,
  ]);
  await report("working", [run.model, run.task].filter(Boolean).join(" ") || agentId);
  note(`running ${agentId} in herdr pane ${pane}`);

  const dir = mkdtempSync(join(tmpdir(), "ask-agent-herdr-"));
  const env = agentEnv();
  writeFileSync(join(dir, "env"), Object.entries(env).map(([key, value]) => `${key}=${value}\0`).join(""));
  writeFileSync(join(dir, "argv"), [run.command, ...run.args].map((value) => `${value}\0`).join(""));
  writeFileSync(join(dir, "run"), runScript);
  const started = await runHerdr(["pane", "run", pane, `bash ${quote(join(dir, "run"))} ${quote(dir)}`]);
  if (started.status !== 0) {
    const reason = started.output.replace(/\n+$/, "").split("\n").at(-1) || `exit ${started.status ?? 1}`;
    rmSync(dir, { recursive: true, force: true });
    await report("idle", `failed to start (${reason})`);
    return { stdout: "", stderr: `[ask-agent] herdr pane run failed (${reason})\n`, status: started.status ?? 1, timedOut: false };
  }

  const rcFile = join(dir, "rc");
  const deadline = Date.now() + run.timeoutSeconds * 1000;
  while (readText(rcFile).trim() === "") {
    if (Date.now() >= deadline) {
      const pid = Number(readText(join(dir, "pid")).trim());
      const stat = Number.isInteger(pid) && pid > 0 ? readProcStat(pid) : null;
      const target = Number.isInteger(pid) && pid > 0 ? (stat && stat.pgrp === pid ? -pid : pid) : 0;
      await runHerdr(["pane", "send-keys", pane, "ctrl+c"]);
      if (target !== 0) {
        const waitExit = async (ms: number) => {
          const until = Date.now() + ms;
          while (Date.now() < until && readText(rcFile).trim() === "" && isTargetAlive(target)) {
            await sleep(50);
          }
        };
        await waitExit(500);
        if (readText(rcFile).trim() === "" && isTargetAlive(target)) {
          try { process.kill(target, "SIGTERM"); } catch {}
          await waitExit(500);
        }
        if (readText(rcFile).trim() === "" && isTargetAlive(target)) {
          try { process.kill(target, "SIGKILL"); } catch {}
          await waitExit(200);
        }
      }
      await report("idle", `timed out after ${run.timeoutSeconds}s`);
      rmSync(dir, { recursive: true, force: true });
      return { stdout: "", stderr: "", status: 142, timedOut: true };
    }
    await sleep(250);
  }
  const result = {
    stdout: readText(join(dir, "out")),
    stderr: readText(join(dir, "err")),
    status: Number(readText(rcFile).trim()),
    timedOut: false,
  };
  rmSync(dir, { recursive: true, force: true });
  if (result.status === 0) {
    await runHerdr(["pane", "release-agent", pane, "--source", "ask-agent", "--agent", agentId]);
    await runHerdr(["pane", "close", pane]);
  } else {
    await report("idle", `failed (exit ${result.status})`);
  }
  return result;
}
