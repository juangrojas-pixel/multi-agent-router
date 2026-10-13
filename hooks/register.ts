import type { Register } from 'claude-code'

const POLICY = `## External agents (multi-agent-router)

You can delegate to other agent CLIs through \`ask-agent\` (Bash) or the subagents
codex-thinker, agy-worker and opencode-docs. Load the \`delegate\` skill before delegating.

- think (codex, then agy): architecture, hard bugs, independent second opinion.
- execute (agy, then codex): bounded, well-specified tasks; verify the result before using it.
- draft (opencode, then agy): docs, summaries, boilerplate. Never for important decisions or code you ship unverified.
- gentle-shell: only when the user asks for it explicitly.

External agents are read-only advisors. You stay the only writer and the final judge.`

// Keeps the injected readiness short: one line per agent, no quota table.
function summarize(status: string): string {
  return status
    .split('\n')
    .filter(line => /\b(ready|skip:)/.test(line))
    .map(line => `- ${line.replace(/\s+/g, ' ').trim()}`)
    .join('\n')
}

function statusLine(status: string): string {
  return status
    .split('\n')
    .filter(line => /\b(ready|skip:)/.test(line))
    .map(line => `${line.trim().split(/\s+/)[0]}${/\bready\b/.test(line) ? '✓' : '✗'}`)
    .join(' ')
}

export const register: Register = on => {
  let readiness = 'Readiness not checked yet; run `ask-agent status`.'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void (async () => {
      try {
        const { exitCode, stdout } = await $.process.run([`${$.plugin.root}/bin/ask-agent`, 'status'], {
          timeoutMs: 90_000,
        })
        if (exitCode !== 0 || !stdout.trim()) return
        readiness = `Agent readiness at session start:\n${summarize(stdout)}`
        $.ui.status(`agents: ${statusLine(stdout)}`)
      } catch (error) {
        $.ui.log(`multi-agent-router: status check failed: ${String(error)}`, { to: 'debug' })
      }
    })()
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [
        ...composed.sections,
        { id: `${$.plugin.name}:agents`, text: `${POLICY}\n\n${readiness}`, scope: 'session' as const },
      ],
    }
  })
}
