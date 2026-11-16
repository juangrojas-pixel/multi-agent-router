import type { Register } from 'claude-code'

// The guidance comes from the router (`bin/ask-agent-ts guidance`, generated from the roles in
// agents.json); bin/route-hint uses the same text when no rule matches. This frame names no
// agent, role or rule of its own, so the adapter holds no routing logic.
const FRAME = `## External agents (multi-agent-router)

Delegate through the router (Bash) as the guidance below says. Per-prompt routing directives
come from the route-hint hook. You stay the final judge.`

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
    // Called by path under the plugin root, never through `ask-agent` on PATH; awaited so the
    // first prompt already carries it. Falls back to `routing.general` when it fails or is empty.
    try {
      const { exitCode, stdout } = await $.process.run([`${$.plugin.root}/bin/ask-agent-ts`, 'guidance'], {
        timeoutMs: 5_000,
      })
      if (exitCode === 0) policy = stdout.trim()
    } catch (error) {
      $.ui.log(`multi-agent-router: guidance failed: ${String(error)}`, { to: 'debug' })
    }
    if (!policy) {
      try {
        const { exitCode, stdout } = await $.process.run(
          ['jq', '-r', '.routing.general // empty', `${$.plugin.root}/agents.json`],
          { timeoutMs: 5_000 },
        )
        if (exitCode === 0) policy = stdout.trim()
      } catch (error) {
        $.ui.log(`multi-agent-router: policy read failed: ${String(error)}`, { to: 'debug' })
      }
    }
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
