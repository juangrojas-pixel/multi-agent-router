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

// Runs `change` while holding the cooldown lock, the `cooldown.json.lock` directory the bash
// router also uses. A lock older than 30 s is broken; a live one is waited on for up to 10 s,
// then the write is skipped (returns false) rather than raced.
function withCooldownLock(change: (data: Record<string, number>) => Record<string, number>): boolean {
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
      if (Date.now() >= deadline) return false;
      wait(100);
    }
  }

  try {
    let data: Record<string, number> = {};
    try { data = JSON.parse(readFileSync(file, "utf8")); } catch {}
    const temp = join(stateDir(), `cooldown.${process.pid}.${Date.now()}`);
    writeFileSync(temp, JSON.stringify(change(data)));
    renameSync(temp, file);
    return true;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function setCooldown(agent: string, until: number): void {
  withCooldownLock((data) => ({ ...data, [agent]: until }));
}

// Clears one agent's cooldown, or every cooldown when `agent` is empty. False when the lock was busy.
export function clearCooldown(agent: string): boolean {
  return withCooldownLock((data) => {
    if (!agent) return {};
    const { [agent]: _cleared, ...rest } = data;
    return rest;
  });
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

// jq's @tsv: backslash, tab, newline and carriage return are escaped.
function tsv(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

// A value as jq's string interpolation prints it: strings raw, null as "null".
export function jqText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "null";
  return typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

export function runsFile(): string { return join(stateDir(), "runs.jsonl"); }

// The run history as TSV lines, oldest first: the last `limit` runs, of `agent` only when given.
// Times are UTC, as jq's strftime prints them. Null when nothing is recorded; corrupt lines are skipped.
export function runsTable(limit: number, agent: string): string | null {
  let content: string;
  try { content = readFileSync(runsFile(), "utf8"); } catch { return null; }
  if (!content) return null;
  const rows: string[] = [];
  for (const line of content.split("\n")) {
    let run: Record<string, unknown>;
    try { run = JSON.parse(line); } catch { continue; }
    if (typeof run !== "object" || run === null || Array.isArray(run)) continue;
    if (agent && run.agent !== agent) continue;
    if (typeof run.ts !== "number") continue;
    const time = new Date(run.ts * 1000).toISOString().slice(0, 16).replace("T", " ");
    const files = run.changed_files;
    const count = Array.isArray(files) ? files.length : typeof files === "string" ? [...files].length : 0;
    const prompt = [...String(run.prompt ?? "").replace(/\s+/g, " ")].slice(0, 80).join("");
    const fields = [time, jqText(run.agent), `exit=${jqText(run.exit)}`, `${jqText(run.seconds)}s`, `files=${count}`, jqText(run.cwd), prompt];
    rows.push(fields.map(tsv).join("\t"));
  }
  return rows.slice(limit === 0 ? rows.length : -limit).map((row) => `${row}\n`).join("");
}
