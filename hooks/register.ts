import type { Register } from 'claude-code'

// The routing policy lives in agents.json (`routing.general`); bin/route-hint turns it
// into a per-prompt directive. This section only frames it, so the two never disagree.
const FRAME = `## External agents (multi-agent-router)

Delegate through \`ask-agent -a <agent>\` (Bash). Per-prompt routing directives come from
the route-hint hook and follow agents.json. gentle-shell, agy and opencode are executors that
write inside -C DIR and return a receipt; codex is a read-only advisor. Trust the receipt:
check one thing, never redo their work. You stay the final judge.`

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
  let policy = ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Shown at once so the person sees the hook ran while the slow check is pending.
    $.ui.status('agents: checking…')
    void (async () => {
      try {
        const { exitCode, stdout } = await $.process.run(
          ['jq', '-r', '.routing.general // empty', `${$.plugin.root}/agents.json`],
          { timeoutMs: 5_000 },
        )
        if (exitCode === 0) policy = stdout.trim()
      } catch (error) {
        $.ui.log(`multi-agent-router: policy read failed: ${String(error)}`, { to: 'debug' })
      }
    })()
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
        { id: `${$.plugin.name}:agents`, text: [FRAME, policy, readiness].filter(Boolean).join('\n\n'), scope: 'session' as const },
      ],
    }
  })
}
