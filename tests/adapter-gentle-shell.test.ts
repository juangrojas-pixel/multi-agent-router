import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, scratchConfig } from "./fixtures/helpers.ts";

const root = resolve(import.meta.dirname, "..");
const adapter = join(root, "adapters", "gentle-shell", "orchestrate");

// A gentle-shell stand-in on PATH that prints each argument it got, one per line.
function setup(config: object) {
  const scratch = scratchConfig(config);
  const bin = join(scratch.root, "bin");
  mkdirSync(bin);
  const stub = join(bin, "gentle-shell");
  writeFileSync(stub, "#!/usr/bin/env bash\nfor a in \"$@\"; do printf '<%s>\\n' \"$a\"; done\n");
  chmodSync(stub, 0o755);
  return { ...scratch, env: { ...scratch.env, PATH: `${bin}:${process.env.PATH}` } };
}

function run(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(adapter, args, { encoding: "utf8", env });
}

const agent = { enabled: true, command: fixture("stub-ok"), timeout_seconds: 1, args: ["{prompt}"], output: "text" };

test("the gentle-shell adapter starts gentle-shell with the generated guidance", () => {
  const s = setup({
    agents: { agy: agent },
    roles: { docs: { description: "Drafts low-stakes text.", agents: ["agy"] } },
    routing: { notes: "Secrets stay inline.", general: "GENERAL" },
  });
  const guidance = spawnSync(join(root, "bin", "ask-agent-ts"), ["guidance"], { encoding: "utf8", env: s.env }).stdout;
  const result = run(s.env, ["fix", "the bug"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `<-->\n<--append-system-prompt>\n<${guidance.trimEnd()}>\n<fix>\n<the bug>\n`);
});

test("the adapter falls back to routing.general when the guidance command fails", () => {
  const s = setup({
    agents: { agy: agent },
    roles: { docs: { description: "d", agents: ["ghost"] } },
    routing: { general: "GENERAL" },
  });
  const result = run(s.env, ["task"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "<-->\n<--append-system-prompt>\n<GENERAL>\n<task>\n");
});

test("the adapter falls back to routing.general when the guidance is empty", () => {
  const s = setup({ agents: { agy: agent }, routing: { general: "GENERAL" } });
  const result = run(s.env, ["task"]);
  assert.equal(result.stdout, "<-->\n<--append-system-prompt>\n<GENERAL>\n<task>\n");
});

test("the adapter's fall back reads routing.general from the merged config first", () => {
  const s = setup({ agents: { agy: agent }, routing: { general: "GENERAL" } });
  const policy = join(s.root, "config", "multi-agent-router", "policy.json");
  mkdirSync(join(policy, ".."), { recursive: true });
  writeFileSync(policy, JSON.stringify({ routing: { general: "PRIVATE GENERAL" } }));
  const result = run(s.env, ["task"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "<-->\n<--append-system-prompt>\n<PRIVATE GENERAL>\n<task>\n");
});
