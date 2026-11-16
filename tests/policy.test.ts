import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

function config(): object {
  return {
    agents: {
      argv: { enabled: true, command: fixture("stub-argv"), timeout_seconds: 1, args: ["{prompt}"], output: "text", extra_args: ["a"] },
      ok: { enabled: true, command: fixture("stub-ok"), timeout_seconds: 1, args: ["{prompt}"], output: "text" },
    },
    roles: { coder: { description: "repo description", agents: ["argv"] } },
    routing: { notes: "repo notes", general: "repo general" },
  };
}

function writePolicy(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function defaultPolicyPath(root: string): string { return join(root, "config", "multi-agent-router", "policy.json"); }

test("a private policy file adds a preamble that reaches the agent", () => {
  const s = scratchConfig(config());
  writePolicy(defaultPolicyPath(s.root), JSON.stringify({ agents: { argv: { prompt_preamble: "PRIVATE RULES" } } }));
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "PRIVATE RULES\n\nhello\n");
});

test("without a private policy file the same task gets no preamble and no error", () => {
  const s = scratchConfig(config());
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello\n");
  assert.equal(result.stderr, "[ask-agent] using argv\n");
});

test("ASK_AGENT_POLICY overrides the policy path", () => {
  const s = scratchConfig(config());
  writePolicy(defaultPolicyPath(s.root), JSON.stringify({ routing: { notes: "default file" } }));
  const other = join(s.root, "elsewhere", "mine.json");
  writePolicy(other, JSON.stringify({ routing: { notes: "override file" } }));
  const result = runCli(["guidance"], { ...s.env, ASK_AGENT_POLICY: other });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\n\noverride file\n$/);
  assert.doesNotMatch(result.stdout, /default file/);
});

test("objects merge key by key while scalars and arrays from the private file replace", () => {
  const s = scratchConfig(config());
  writePolicy(defaultPolicyPath(s.root), JSON.stringify({
    agents: { argv: { extra_args: ["b"] } },
    roles: { coder: { description: "private description" }, docs: { description: "private role", agents: ["ok"] } },
    routing: { notes: "private notes" },
  }));
  const roles = runCli(["roles"], s.env);
  assert.equal(roles.status, 0);
  assert.equal(roles.stdout, "coder\targv\t-\t-\tyes\t\ndocs\tok\t-\t-\tyes\t\n");
  const guidance = runCli(["guidance"], s.env);
  assert.match(guidance.stdout, /^- coder: private description Call:/m);
  assert.match(guidance.stdout, /\n\nprivate notes\n$/);
  const argv = scratchConfig(config());
  writePolicy(defaultPolicyPath(argv.root), JSON.stringify({ agents: { argv: { extra_args: ["b"], args: ["{extra_args}", "{prompt}"] } } }));
  const run = runCli(["-r", "coder", "hello"], argv.env);
  assert.equal(run.stdout, "b\nhello\n");
});

test("invalid JSON in the private file exits 2 naming the file", () => {
  const s = scratchConfig(config());
  const path = defaultPolicyPath(s.root);
  writePolicy(path, "{ not json");
  for (const args of [["-r", "coder", "hello"], ["roles"], ["guidance"]]) {
    const result = runCli(args, s.env);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`^\\[ask-agent\\] config: ${path.replaceAll("/", "\\/")}: `));
  }
});

test("a private file that is not a JSON object exits 2 naming the file", () => {
  const s = scratchConfig(config());
  const path = defaultPolicyPath(s.root);
  writePolicy(path, "[1, 2]");
  const result = runCli(["roles"], s.env);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, `[ask-agent] config: ${path}: not a JSON object\n`);
});

test("a rule broken by the private file exits 2 naming the file and the key", () => {
  const s = scratchConfig(config());
  const path = defaultPolicyPath(s.root);
  writePolicy(path, JSON.stringify({ roles: { coder: { agents: ["ghost"] } } }));
  const result = runCli(["-r", "coder", "hello"], s.env);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `[ask-agent] config: ${path}: roles.coder.agents[0]: unknown agent: ghost\n`);
});

test("a mistake already in the repository config is reported without the private file path", () => {
  const broken = config() as { roles: Record<string, { agents: string[] }> };
  broken.roles.coder.agents = ["ghost"];
  const s = scratchConfig(broken);
  writePolicy(defaultPolicyPath(s.root), JSON.stringify({ routing: { notes: "x" } }));
  const result = runCli(["roles"], s.env);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "[ask-agent] config: roles.coder.agents[0]: unknown agent: ghost\n");
});
