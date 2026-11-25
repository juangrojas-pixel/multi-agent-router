import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessResult } from "./hc.ts";

// Runs inside the Herdr pane: restores the router's environment, runs the agent with the
// arguments stored NUL-separated in "$d/argv" (the prompt never goes through the pane's command
// line), shows its output live and keeps stdout, stderr and the exit code for the router.
const runScript = `d="$1"
while IFS= read -r -d '' kv; do export "$kv" 2>/dev/null; done <"$d/env"
args=()
while IFS= read -r -d '' a; do args+=("$a"); done <"$d/argv"
"\${args[@]}" </dev/null 2> >(tee "$d/err" >&2) | tee "$d/out"
rc=\${PIPESTATUS[0]}
wait $! 2>/dev/null
printf '%s\\n' "$rc" >"$d/rc.tmp" && mv "$d/rc.tmp" "$d/rc"
`;

type Captured = { output: string; status: number | null };

function capture(command: string, args: string[]): Promise<Captured> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.on("error", (failure) => { output += `${command}: ${failure.message}\n`; });
    child.on("close", (status) => resolve({ output, status }));
  });
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
  const split = await capture(herdr, ["pane", "split", "--current", "--direction", "right", "--cwd", process.cwd(), "--no-focus"]);
  const pane = split.status === 0 ? paneId(split.output) : "";
  if (!pane) {
    const lines = split.output.replace(/\n+$/, "").split("\n");
    note(`herdr unavailable (${lines.at(-1) ?? ""}), falling back to subprocess`);
    return fallback();
  }
  const label = [agentId, run.task || run.model].filter(Boolean).join(" ");
  await capture(herdr, ["pane", "rename", pane, label]);
  const report = (state: string, message: string) => capture(herdr, [
    "pane", "report-agent", pane, "--source", "ask-agent", "--agent", agentId, "--state", state, "--message", message,
  ]);
  await report("working", [run.model, run.task].filter(Boolean).join(" ") || agentId);
  note(`running ${agentId} in herdr pane ${pane}`);

  const dir = mkdtempSync(join(tmpdir(), "ask-agent-herdr-"));
  const env = { ...process.env, ASK_AGENT_DEPTH: "1" };
  writeFileSync(join(dir, "env"), Object.entries(env).map(([key, value]) => `${key}=${value}\0`).join(""));
  writeFileSync(join(dir, "argv"), [run.command, ...run.args].map((value) => `${value}\0`).join(""));
  writeFileSync(join(dir, "run"), runScript);
  await capture(herdr, ["pane", "run", pane, `bash ${quote(join(dir, "run"))} ${quote(dir)}`]);

  const rcFile = join(dir, "rc");
  const deadline = Date.now() + run.timeoutSeconds * 1000;
  while (readText(rcFile).trim() === "") {
    if (Date.now() >= deadline) {
      await capture(herdr, ["pane", "send-keys", pane, "ctrl+c"]);
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
    await capture(herdr, ["pane", "release-agent", pane, "--source", "ask-agent", "--agent", agentId]);
    await capture(herdr, ["pane", "close", pane]);
  } else {
    await report("idle", `failed (exit ${result.status})`);
  }
  return result;
}
