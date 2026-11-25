import test from "node:test";
import assert from "node:assert/strict";
import { fixture, runCli, scratchConfig } from "./fixtures/helpers.ts";

function agent(): object {
  return { enabled: true, command: fixture("stub-ok"), timeout_seconds: 1, args: ["{prompt}"], output: "text" };
}

function config(extra: object): object {
  return {
    agents: { claude: agent(), "gentle-shell": agent(), agy: agent() },
    roles: {
      coder: { description: "Writes and edits code from a clear task.", agents: ["gentle-shell", "agy"] },
      docs: { description: "Drafts low-stakes text.", agents: ["agy"] },
    },
    ...extra,
  };
}

const roleLines = [
  "Delegate by role through the router. Each line is a role, what it is for, and the call to make:",
  "- coder: Writes and edits code from a clear task. Call: `ask-agent -r coder -C <dir> \"<task>\"`",
  "- docs: Drafts low-stakes text. Call: `ask-agent -r docs -C <dir> \"<task>\"`",
];

test("guidance lists each role with its description and call form", () => {
  const s = scratchConfig(config({}));
  const result = runCli(["guidance"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${roleLines.join("\n")}\n`);
});

test("guidance appends routing.notes after the roles", () => {
  const s = scratchConfig(config({ routing: { notes: "Secrets stay inline." } }));
  const result = runCli(["guidance"], s.env);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${roleLines.join("\n")}\n\nSecrets stay inline.\n`);
});

test("guidance reflects a changed role description with no other edit", () => {
  const changed = config({}) as { roles: Record<string, { description: string }> };
  changed.roles.docs.description = "Summaries and changelogs.";
  const s = scratchConfig(changed);
  const result = runCli(["guidance"], s.env);
  assert.match(result.stdout, /^- docs: Summaries and changelogs\. Call:/m);
});

test("guidance is the same and names no product whichever agent orchestrates", () => {
  const outputs = ["claude", "gentle-shell"].map((id) => runCli(["guidance"], scratchConfig(config({ orchestrator: { agent: id } })).env));
  for (const result of outputs) {
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /claude|gentle-shell/i);
  }
  assert.equal(outputs[0].stdout, outputs[1].stdout);
});

test("guidance with no roles prints only the notes, or nothing, with exit 0", () => {
  const withNotes = runCli(["guidance"], scratchConfig({ agents: { agy: agent() }, routing: { notes: "Only notes." } }).env);
  assert.equal(withNotes.status, 0);
  assert.equal(withNotes.stdout, "Only notes.\n");
  const empty = runCli(["guidance"], scratchConfig({ agents: { agy: agent() } }).env);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, "");
});

test("a nested -r call is still refused", () => {
  const s = scratchConfig(config({}));
  const result = runCli(["-r", "coder", "hello"], { ...s.env, ASK_AGENT_DEPTH: "1" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /nested call refused/);
});

test("with the dispatcher configured, guidance explains choosing agent and model per task", () => {
  const s = scratchConfig(config({
    capability_tiers: ["light", "standard", "strong", "frontier"],
    kinds: ["code", "writing"],
    routing: { notes: "Secrets stay inline." },
  }));
  const result = runCli(["guidance"], s.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    ...roleLines,
    "",
    "Choose agent and model per task with evidence (roles stay the default):",
    "1. Before a plan: `ask-agent preflight` (versions, quotas, usable models).",
    "2. Per task: `ask-agent candidates --kind <code|writing> --tier <light|standard|strong|frontier> --size <s|m|l>` lists capable agent/model pairs, cheapest first. Pick the cheapest that is good enough.",
    "3. Run it and record why: `ask-agent -a <agent> -m <model> --task <id> --reason \"<why>\" -C <dir> \"<task>\"`.",
    "4. Distinct tasks at the same time: `ask-agent dispatch -f <batch.json>`, one receipt per task.",
    "5. Client servers, cloud or databases: only agents allowed for client work (`candidates --client`).",
    "",
    "Secrets stay inline.",
    "",
  ].join("\n"));
});
