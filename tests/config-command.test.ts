import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

function config(): object {
  return {
    agents: { one: { enabled: true, command: fixture("stub-ok"), timeout_seconds: 1, args: ["{prompt}"], output: "text" } },
    roles: { coder: { description: "repo description", agents: ["one"] } },
    routing: { general: "repo general", notes: "repo notes", rules: [{ id: "r1", agent: "one", match: "x" }] },
  };
}

function writePolicy(root: string, content: string): string {
  const path = join(root, "config", "multi-agent-router", "policy.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

test("config prints the repository config as JSON when there is no private policy", () => {
  const s = scratchConfig(config());
  const result = runCli(["config"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${JSON.stringify(config(), null, 2)}\n`);
});

test("config prints the repository config merged with the private policy", () => {
  const s = scratchConfig(config());
  writePolicy(s.root, JSON.stringify({ routing: { general: "private general", rules: [{ id: "p1", agent: "one", match: "y" }] } }));
  const result = runCli(["config"], s.env);
  assert.equal(result.status, 0);
  const printed = JSON.parse(result.stdout);
  assert.equal(printed.routing.general, "private general");
  assert.equal(printed.routing.notes, "repo notes");
  assert.deepEqual(printed.routing.rules, [{ id: "p1", agent: "one", match: "y" }]);
  assert.equal(printed.roles.coder.description, "repo description");
  assert.match(result.stdout, /^\{\n  "agents": \{\n/);
  assert.match(result.stdout, /\}\n$/);
});

test("config honors ASK_AGENT_POLICY", () => {
  const s = scratchConfig(config());
  const other = join(s.root, "elsewhere.json");
  writeFileSync(other, JSON.stringify({ routing: { notes: "override notes" } }));
  const result = runCli(["config"], { ...s.env, ASK_AGENT_POLICY: other });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).routing.notes, "override notes");
});

test("config with an invalid private policy exits 2 naming the file", () => {
  const s = scratchConfig(config());
  const path = writePolicy(s.root, "{ not json");
  const result = runCli(["config"], s.env);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`^\\[ask-agent\\] config: ${path.replaceAll("/", "\\/")}: `));
});

test("config is allowed inside a nested call", () => {
  const s = scratchConfig(config());
  const result = runCli(["config"], { ...s.env, ASK_AGENT_DEPTH: "1" });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).routing.general, "repo general");
});

test("--help lists the config command", () => {
  const s = scratchConfig(config());
  const result = runCli(["--help"], s.env);
  assert.match(result.stdout, /ask-agent config\s+/);
});
