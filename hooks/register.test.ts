import { expect, test } from 'claude-code/testing'

const composeInput = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: ['Bash'],
  outputStyle: null,
  traits: [],
}

const GUIDANCE = '- coder: Writes code. Call: `ask-agent-ts -r coder -C <dir> "<task>"`'

// Stands in for the host commands the module runs: the guidance, the general policy and status.
function host(on: any, answers: { guidance: { exitCode: number; stdout: string }; general?: string }) {
  const calls: string[][] = []
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine intro', scope: 'shared' as const }] }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    calls.push([...e.argv])
    const argv = e.argv.join(' ')
    if (argv.endsWith('/bin/ask-agent-ts guidance')) return { value: { ...answers.guidance, stderr: '' } }
    if (argv.startsWith('jq ')) return { value: { exitCode: 0, stdout: `${answers.general ?? ''}\n`, stderr: '' } }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('ui.status', () => ({ value: undefined }))
  return calls
}

test('appends the generated guidance as the last session section', async ($, on) => {
  const calls = host(on, { guidance: { exitCode: 0, stdout: `${GUIDANCE}\n` }, general: 'GENERAL' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const { sections } = await $.prompt.compose(composeInput)
  const last = sections[sections.length - 1]

  expect(sections[0].id).toBe('intro')
  expect(last.id).toBe('multi-agent-router:agents')
  expect(last.scope).toBe('session')
  expect(last.text).toContain(GUIDANCE)
  expect(last.text).not.toContain('GENERAL')
  expect(calls.some(argv => argv[0].endsWith('/bin/ask-agent-ts') && argv[1] === 'guidance')).toBe(true)
})

test('falls back to routing.general when the guidance command fails', async ($, on) => {
  host(on, { guidance: { exitCode: 2, stdout: '' }, general: 'GENERAL' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const { sections } = await $.prompt.compose(composeInput)
  expect(sections[sections.length - 1].text).toContain('GENERAL')
})

test('falls back to routing.general when the guidance is empty', async ($, on) => {
  host(on, { guidance: { exitCode: 0, stdout: '\n' }, general: 'GENERAL' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const { sections } = await $.prompt.compose(composeInput)
  expect(sections[sections.length - 1].text).toContain('GENERAL')
})

test('the frame names no agent of its own', async ($, on) => {
  host(on, { guidance: { exitCode: 0, stdout: 'X\n' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const { sections } = await $.prompt.compose(composeInput)
  expect(sections[sections.length - 1].text).not.toMatch(/gentle-shell|agy|opencode|codex/)
})
