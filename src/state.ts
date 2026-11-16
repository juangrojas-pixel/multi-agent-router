import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function stateDir(): string {
  const cache = process.env.XDG_CACHE_HOME || join(process.env.HOME || "/tmp", ".cache");
  return join(cache, "multi-agent-router");
}

function ensure(): void { mkdirSync(stateDir(), { recursive: true }); }
function cooldownFile(): string { return join(stateDir(), "cooldown.json"); }
function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function cooldown(agent: string): number {
  try { return Number(JSON.parse(readFileSync(cooldownFile(), "utf8"))[agent] ?? 0); } catch { return 0; }
}

export function setCooldown(agent: string, until: number): void {
  ensure();
  const file = cooldownFile();
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) return;
      wait(100);
    }
  }

  try {
    let data: Record<string, number> = {};
    try { data = JSON.parse(readFileSync(file, "utf8")); } catch {}
    data[agent] = until;
    const temp = join(stateDir(), `cooldown.${process.pid}.${Date.now()}`);
    writeFileSync(temp, JSON.stringify(data));
    renameSync(temp, file);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function gitSnapshot(): string {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inside.status !== 0) return "";
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return `${head.status === 0 ? head.stdout.trim() : "-"}\n${status.stdout ?? ""}`;
}

export function changedFiles(before: string, after: string): string[] {
  if (!after) return [];
  const [beforeHead = "-", ...beforeLines] = before.split("\n");
  const [afterHead = "-", ...afterLines] = after.split("\n");
  const oldStatuses = new Set(beforeLines.filter(Boolean));
  const files = new Set(
    afterLines
      .filter((line) => line && !oldStatuses.has(line))
      .map((line) => line.slice(3).replace(/^.* -> /, "")),
  );
  if (beforeHead !== afterHead && beforeHead !== "-" && afterHead !== "-") {
    const diff = spawnSync("git", ["diff", "--name-only", beforeHead, afterHead], { encoding: "utf8" });
    if (diff.status === 0) for (const file of diff.stdout.split("\n")) if (file) files.add(file);
  }
  return [...files].sort().slice(0, 200);
}

export function record(
  agent: string,
  tier: string,
  model: string,
  ts: number,
  exit: number,
  seconds: number,
  prompt: string,
  answer: string,
  files: string[],
  role = "",
): void {
  ensure();
  const row = {
    ts,
    agent,
    tier,
    role,
    model,
    cwd: process.cwd(),
    exit,
    seconds,
    prompt: prompt.slice(0, 2000),
    prompt_chars: prompt.length,
    answer: answer.slice(0, 2000),
    changed_files: files,
  };
  appendFileSync(join(stateDir(), "runs.jsonl"), `${JSON.stringify(row)}\n`);

  const lastDir = join(stateDir(), "last");
  mkdirSync(lastDir, { recursive: true });
  const tempDir = mkdtempSync(join(lastDir, ".last-"));
  const temp = join(tempDir, "value");
  writeFileSync(temp, JSON.stringify({ agent, tier, ts, exit, seconds, answer: answer.slice(0, 2000) }));
  renameSync(temp, join(lastDir, `${agent}.json`));
  rmSync(tempDir, { recursive: true, force: true });
}
