import { expect, mock, test } from 'claude-code/testing'

const WINDOWS = [
  { kind: 'five_hour', percentUsed: 58, resetsAt: '2099-01-01T00:00:00Z' },
  { kind: 'seven_day', percentUsed: 12.5 },
]

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 4,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 4 },
  view: {},
} as const

test('the band shows percent left for each window once a reading lands', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2098-12-31T22:00:00Z') })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: WINDOWS },
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'ribbon',
      surface,
      component: 'AbovePrompt',
      props: PROPS,
    })
    expect(await band.find({ text: '42%' })).toBeDefined()
    expect(await band.find({ text: '88%' })).toBeDefined()
    // 7D (87.5% left) draws before 5H (42% left)
    const all = JSON.stringify(await band.find({ type: 'Box' }))
    expect(all.indexOf('7D')).toBeLessThan(all.indexOf('5H'))
    await band.unmount()
  }
})

test('the band stays one row at every width, dropping detail as it narrows', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2098-12-31T22:00:00Z') })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: WINDOWS },
  }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  for (const cols of [100, 60, 36, 24, 16]) {
    const band = await $.ui.mount({
      plugin: 'ribbon',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { ...PROPS, bodyColumns: cols },
    })
    const row = await band.find({ key: 'row' })
    expect(row?.props.height).toBe(1)
    const text = (await band.find({ key: 'line' }))?.text ?? ''
    expect(text.length).toBeLessThanOrEqual(cols - 2)
    expect(await band.find({ text: '42%' })).toBeDefined()
    await band.unmount()
  }

  const wide = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await wide.find({ text: ' 2h 0m' })).toBeDefined()
  await wide.unmount()

  const narrow = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 16 } })
  expect((await narrow.find({ key: 'line' }))?.text).toBe('7D 88%  5H 42%')
  await narrow.unmount()
})
