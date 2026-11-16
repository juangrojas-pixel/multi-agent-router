import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

const root = resolve(import.meta.dirname, "..");

function agent(command: string): object {
  return { enabled: true, command, timeout_seconds: 5, args: ["{prompt}"], output: "text" };
}

function lockDir(scratchRoot: string): string {
  const dir = join(scratchRoot, "cache", "multi-agent-router");
  mkdirSync(dir, { recursive: true });
  return join(dir, "cooldown.json.lock");
}

test("reset logs a stale cooldown lock it breaks, like the bash router", () => {
  const s = scratchConfig({ agents: { codex: agent(fixture("stub-ok")) } });
  const lock = lockDir(s.root);
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const result = runCli(["reset", "codex"], s.env);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /^\[ask-agent\] removing stale cooldown lock \(6\ds old\)\n\[ask-agent\] cooldown cleared codex\n$/);
});

test("a quota run that finds the lock busy logs the skip and writes no cooldown", () => {
  const s = scratchConfig({ cooldown_seconds: 3600, agents: { "gentle-shell": agent(fixture("stub-quota")) } });
  mkdirSync(lockDir(s.root));
  const result = runCli(["-a", "gentle-shell", "hi"], s.env);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^\[ask-agent\] cooldown lock busy, skipping write$/m);
  let data: Record<string, number> = {};
  try { data = JSON.parse(readFileSync(join(s.root, "cache", "multi-agent-router", "cooldown.json"), "utf8")); } catch {}
  assert.equal(data["gentle-shell"], undefined);
});

test("parallel strips trailing newlines from answers and from a stdin prompt, like the bash router", () => {
  const s = scratchConfig({ default_tier: "think", tiers: { think: ["codex"] }, agents: { codex: { ...agent("") } } });
  const stub = join(s.root, "stub-trailing");
  writeFileSync(stub, "#!/usr/bin/env bash\nprintf '%s\\n\\n\\n' \"${@: -1}\"\n");
  chmodSync(stub, 0o755);
  writeFileSync(s.config, JSON.stringify({ default_tier: "think", tiers: { think: ["codex"] }, agents: { codex: agent(stub) } }));
  const result = spawnSync(join(root, "bin", "ask-agent-ts"), ["parallel"], { encoding: "utf8", env: s.env, input: "task\n" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "### codex\n\ntask\n\n");
  const rows = readFileSync(join(s.root, "cache", "multi-agent-router", "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows[0].prompt_chars, 4);
});

test("an -a answer with trailing blank lines prints once with a single newline", () => {
  const s = scratchConfig({ agents: { codex: agent("") } });
  const stub = join(s.root, "stub-trailing");
  writeFileSync(stub, "#!/usr/bin/env bash\nprintf '%s\\n\\n' \"${@: -1}\"\n");
  chmodSync(stub, 0o755);
  writeFileSync(s.config, JSON.stringify({ agents: { codex: agent(stub) } }));
  const result = runCli(["-a", "codex", "hello"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
});
