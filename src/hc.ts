import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ProcessResult = { stdout: string; stderr: string; status: number; timedOut: boolean };

// Runs inside the hc terminal: restores the router's environment, shows the agent's output live
// (tee) and keeps stdout, stderr and the exit code in files the router reads afterwards.
const runScript = `d="$1"; shift
while IFS= read -r -d '' kv; do export "$kv" 2>/dev/null; done <"$d/env"
"$@" </dev/null 2> >(tee "$d/err" >&2) | tee "$d/out"
rc=\${PIPESTATUS[0]}
wait $! 2>/dev/null
printf '%s\\n' "$rc" >"$d/rc.tmp" && mv "$d/rc.tmp" "$d/rc"
`;

type Captured = { output: string; status: number | null; error: string };

// Runs an hc subcommand; `output` is stdout and stderr together, as `2>&1` gives them.
function capture(command: string, args: string[]): Promise<Captured> {
  return new Promise((resolve) => {
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
    child.on("close", (status) => resolve({ output: error ? `${output}${error}\n` : output, status, error }));
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function now(): number { return Math.floor(Date.now() / 1000); }

function note(message: string): void { process.stderr.write(`[ask-agent] ${message}\n`); }

function readText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function address(output: string): string {
  try {
    const value = JSON.parse(output).address;
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

// Runs `command args` inside a live hc terminal that `hc attach NAME` shows while it works.
// stdout, stderr and the exit code come back exactly as a subprocess run gives them; the
// terminal is removed afterwards, and killed when `timeoutSeconds` pass (status 142).
// When hc cannot start the terminal, `fallback` (the subprocess backend) runs instead.
export async function hcRun(
  hc: string,
  agentId: string,
  command: string,
  args: string[],
  timeoutSeconds: number,
  fallback: () => Promise<ProcessResult>,
): Promise<ProcessResult> {
  const name = `aa-${agentId}-${process.pid}`.slice(0, 32);
  const dir = mkdtempSync(join(tmpdir(), "ask-agent-hc-"));
  const env = { ...process.env, ASK_AGENT_DEPTH: "1" };
  writeFileSync(join(dir, "env"), Object.entries(env).map(([key, value]) => `${key}=${value}\0`).join(""));
  writeFileSync(join(dir, "run"), runScript);
  const started = await capture(hc, [
    "run", "--bg", "--json", "--no-parent", "--no-notify", "--name", name, "--label", "ask-agent=1",
    "--cwd", process.cwd(), "--", "bash", join(dir, "run"), dir, command, ...args,
  ]);
  const addr = address(started.output);
  if (!addr) {
    const lines = started.output.replace(/\n+$/, "").split("\n");
    note(`hc unavailable (${lines.at(-1) ?? ""}), falling back to subprocess`);
    rmSync(dir, { recursive: true, force: true });
    return fallback();
  }
  note(`running in hc terminal ${addr}: hc attach ${name}`);

  const rcFile = join(dir, "rc");
  const done = () => readText(rcFile).trim() !== "";
  const deadline = now() + timeoutSeconds;
  while (!done()) {
    const left = deadline - now();
    if (left <= 0) {
      await capture(hc, ["kill", addr]);
      await capture(hc, ["rm", addr]);
      rmSync(dir, { recursive: true, force: true });
      return { stdout: "", stderr: "", status: 142, timedOut: true };
    }
    const turn = Date.now();
    await capture(hc, ["wait", addr, "--json", "--timeout", String(Math.min(left, 60))]);
    if (done()) break;
    // Ended without writing rc (killed from outside, hc lost it): stop waiting.
    const state = await capture(hc, ["get", addr, "--json"]);
    let live = false;
    try { live = JSON.parse(state.output).state === "live"; } catch {}
    if (!live) {
      await sleep(1_000);
      if (!done()) {
        rmSync(dir, { recursive: true, force: true });
        return { stdout: "", stderr: `[ask-agent] hc terminal ${addr} ended without an exit code\n`, status: 1, timedOut: false };
      }
    }
    // `hc wait` returns early on agent turns; never spin faster than once a second.
    if (Date.now() - turn < 1_000) await sleep(1_000 - (Date.now() - turn));
  }
  const result = {
    stdout: readText(join(dir, "out")),
    stderr: readText(join(dir, "err")),
    status: Number(readText(rcFile).trim()),
    timedOut: false,
  };
  await capture(hc, ["rm", addr]);
  rmSync(dir, { recursive: true, force: true });
  return result;
}
