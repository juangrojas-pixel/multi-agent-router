import type { Agent } from "./config.ts";

export type BuiltAgent = Agent & { args: string[]; output: "text" | "agy-json" | "opencode-events" | "claude-json" };
const defaults: Record<string, Pick<BuiltAgent, "args" | "output" | "model_args">> = {
  codex: { args: ["-p", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "{model_args}", "{extra_args}", "{prompt}"], model_args: ["--model", "{model}"], output: "text" },
  agy: { args: ["-p", "{prompt}", "--output-format", "json", "--print-timeout", "{timeout}s", "{model_args}", "{extra_args}"], model_args: ["--model", "{model}"], output: "agy-json" },
  opencode: { args: ["run", "--format", "json", "{model_args}", "{extra_args}", "{prompt}"], model_args: ["-m", "{model}"], output: "opencode-events" },
  "gentle-shell": { args: ["--", "-p", "--no-session", "{model_args}", "{extra_args}", "{prompt}"], model_args: ["--model", "{model}"], output: "text" },
};
export function buildAgent(id: string, agent: Agent): BuiltAgent {
  const fallback = defaults[id];
  if (!agent.args && !fallback) throw new Error(`unknown agent: ${id}`);
  const output = agent.output ?? fallback?.output;
  if (!output) throw new Error(`unknown agent: ${id}`);
  return {
    ...agent,
    args: agent.args ?? fallback?.args ?? [],
    model_args: agent.model_args ?? fallback?.model_args,
    output,
  };
}
export function commandArgs(id: string, agent: Agent, prompt: string, model: string, effort = ""): string[] {
  const built = buildAgent(id, agent); const timeout = String(agent.timeout_seconds ?? 600);
  const fragments: Record<string, string[]> = {
    "{model_args}": model && built.model_args ? built.model_args.map((x) => x.replaceAll("{model}", model)) : [],
    "{effort_args}": effort && built.effort_args ? built.effort_args.map((x) => x.replaceAll("{effort}", effort)) : [],
    "{extra_args}": agent.extra_args ?? [],
  };
  const out: string[] = [];
  for (const part of built.args) {
    if (part in fragments) out.push(...fragments[part]);
    // The prompt goes in last, so placeholders written inside it reach the agent literally.
    else out.push(part.replaceAll("{timeout}", timeout).replaceAll("{model}", model).replaceAll("{prompt}", prompt));
  }
  return out;
}
export function parseOutput(kind: BuiltAgent["output"], stdout: string): string {
  if (kind === "text") return stdout;
  if (kind === "claude-json") { try { const data = JSON.parse(stdout); return data.is_error ? "" : String(data.result ?? ""); } catch { return ""; } }
  if (kind === "agy-json") { try { const data = JSON.parse(stdout); return data.status === "SUCCESS" ? String(data.response ?? "") : ""; } catch { return ""; } }
  let answer = "";
  for (const line of stdout.split("\n")) { try { const data = JSON.parse(line); if (data.type === "error") return ""; if (data.type === "text") answer += String(data.part?.text ?? ""); } catch {} }
  return answer;
}

// What an agent's output says about the run: the model it reports (claude-json only) and the
// tokens it used (output tokens include thinking/reasoning). Empty for text output.
export type RunMeta = { model?: string; tokens_in?: number; tokens_out?: number };
export function parseMeta(kind: BuiltAgent["output"], stdout: string): RunMeta {
  const num = (value: unknown) => (typeof value === "number" ? value : 0);
  try {
    if (kind === "claude-json") {
      const data = JSON.parse(stdout);
      const usage = data.modelUsage ?? {};
      const model = Object.keys(usage).sort((a, b) => num(usage[b]?.outputTokens) - num(usage[a]?.outputTokens))[0];
      return { ...(model ? { model } : {}), tokens_in: num(data.usage?.input_tokens), tokens_out: num(data.usage?.output_tokens) };
    }
    if (kind === "agy-json") {
      const usage = JSON.parse(stdout).usage;
      if (!usage) return {};
      return { tokens_in: num(usage.input_tokens), tokens_out: num(usage.output_tokens) + num(usage.thinking_tokens) };
    }
  } catch { return {}; }
  if (kind === "opencode-events") {
    let tokensIn = 0; let tokensOut = 0; let seen = false;
    for (const line of stdout.split("\n")) {
      try {
        const tokens = JSON.parse(line).part?.tokens;
        if (!tokens) continue;
        seen = true; tokensIn += num(tokens.input); tokensOut += num(tokens.output) + num(tokens.reasoning);
      } catch {}
    }
    return seen ? { tokens_in: tokensIn, tokens_out: tokensOut } : {};
  }
  return {};
}

// The environment an agent runs with: the router's own, marked nested so the agent cannot route
// back into ask-agent, without the variables dispatch passes only to its child routers.
export function agentEnv(): NodeJS.ProcessEnv {
  const { ASK_AGENT_NO_FALLBACK: _noFallback, ASK_AGENT_BATCH_ID: _batch, ...env } = process.env;
  return { ...env, ASK_AGENT_DEPTH: "1" };
}
