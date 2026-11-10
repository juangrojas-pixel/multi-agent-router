import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
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
  const { ASK_AGENT_DEPTH: _depth, ...cleanEnv } = process.env;
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
