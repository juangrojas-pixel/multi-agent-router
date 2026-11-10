import type { Agent } from "./config.ts";

export type BuiltAgent = Agent & { args: string[]; output: "text" | "agy-json" | "opencode-events" };
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
    else out.push(part.replaceAll("{prompt}", prompt).replaceAll("{timeout}", timeout).replaceAll("{model}", model));
  }
  return out;
}
export function parseOutput(kind: BuiltAgent["output"], stdout: string): string {
  if (kind === "text") return stdout;
  if (kind === "agy-json") { try { const data = JSON.parse(stdout); return data.status === "SUCCESS" ? String(data.response ?? "") : ""; } catch { return ""; } }
  let answer = "";
  for (const line of stdout.split("\n")) { try { const data = JSON.parse(line); if (data.type === "error") return ""; if (data.type === "text") answer += String(data.part?.text ?? ""); } catch {} }
  return answer;
}
