import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");

export function fixture(name: string): string {
  const path = join(root, "tests", "fixtures", name);
  chmodSync(path, 0o755);
  return path;
}

export function scratchConfig(config: object): { root: string; config: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "ask-agent-test-"));
  const cache = join(dir, "cache");
  const configHome = join(dir, "config");
  mkdirSync(cache);
  mkdirSync(configHome);
  const configPath = join(dir, "agents.json");
  writeFileSync(configPath, JSON.stringify(config));
  // Tests never inherit the caller's hc terminal (the auto backend stays on subprocess) or a dispatch's variables.
  const { ASK_AGENT_DEPTH: _depth, HC_TERMINAL_SOCKET: _sock, HC_TERMINAL_ID: _id, HC_SCOPE: _scope, ASK_AGENT_NO_FALLBACK: _nofb, ASK_AGENT_BATCH_ID: _batch, ...cleanEnv } = process.env;
  return {
    root: dir,
    config: configPath,
    env: { ...cleanEnv, ASK_AGENT_CONFIG: configPath, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: configHome },
  };
}

export function runCli(args: string[], env: NodeJS.ProcessEnv): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(join(root, "bin", "ask-agent-ts"), args, { encoding: "utf8", env });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

export function baseConfig(agentCommand = fixture("stub-ok")): object {
  return {
    cooldown_seconds: 3600,
    default_tier: "execute",
    tiers: { execute: ["one"], draft: ["one"] },
    agents: {
      one: { enabled: true, command: agentCommand, timeout_seconds: 1, extra_args: [], args: ["{prompt}"], output: "text" },
      two: { enabled: true, command: agentCommand, timeout_seconds: 1, extra_args: [], args: ["{prompt}"], output: "text" },
    },
  };
}

// A PATH with only what bin/ask-agent-ts itself needs: no jq and no perl, so the bash router cannot run.
export function pathWithoutJq(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-agent-path-"));
  for (const tool of ["bash", "sh", "dirname", "readlink", "cat", "sleep"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    symlinkSync(found, join(dir, tool));
  }
  symlinkSync(process.execPath, join(dir, "node"));
  return dir;
}
