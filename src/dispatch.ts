import type { Config } from "./config.ts";

// `ask-agent dispatch [-f FILE | -] [--json]` (specs/002-agentic-dispatcher/contracts/cli.md).
export async function dispatchCommand(_config: Config, _args: string[]): Promise<number> {
  process.stderr.write("[ask-agent] dispatch: not implemented yet\n");
  return 1;
}
