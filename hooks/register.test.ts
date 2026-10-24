import { expect, test } from 'claude-code/testing'

test('appends the routing policy as the last session section', async ($, on) => {
  on('prompt.compose', () => ({
    sections: [{ id: 'intro', text: 'engine intro', scope: 'shared' as const }],
  }))

  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash'],
    outputStyle: null,
    traits: [],
  })
  const last = sections[sections.length - 1]

  expect(sections[0].id).toBe('intro')
  expect(last.id).toBe('multi-agent-router:agents')
  expect(last.scope).toBe('session')
  expect(last.text).toContain('ask-agent -a <agent>')
  expect(last.text).toContain('Trust the receipt')
  expect(last.text).not.toContain('only when the user asks for it explicitly')
})
