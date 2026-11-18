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

type Node = { type?: string; text?: string; props?: Record<string, unknown>; children?: Node[] }
const lineOf = async (band: { find: (q: object) => Promise<Node | undefined> }) => {
  const n = await band.find({ key: 'line' })
  const svg = n?.children?.find(c => c.type === 'Svg')
  return svg ? { text: String(svg.props?.alt ?? ''), px: Number(svg.props?.width), source: String(svg.props?.source ?? '') } : { text: n?.text ?? '', px: null, source: '' }
}

const start = async ($: any, on: any) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2098-12-31T22:00:00Z') })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: WINDOWS } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

test('the band shows percent left for each window once a reading lands', async ($, on) => {
  await start($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'ribbon', surface, component: 'AbovePrompt', props: PROPS })
    const { text } = await lineOf(band)
    expect(text).toContain('42%')
    expect(text).toContain('88%')
    expect(text.indexOf('7D')).toBeLessThan(text.indexOf('5H'))
    await band.unmount()
  }
})

test('on desktop the strip is a drawing in the brand fonts, with a 4px margin', async ($, on) => {
  await start($, on)
  const band = await $.ui.mount({ plugin: 'ribbon', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const { source } = await lineOf(band)
  expect(source).toContain('font-family:Montserrat')
  expect(source).toContain("font-family:'DM Sans'")
  expect(source).toContain('height="32"')
  await band.unmount()
})

test('the band stays one row at every width, dropping detail as it narrows', async ($, on) => {
  await start($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [100, 60, 36, 24, 16]) {
      const band = await $.ui.mount({ plugin: 'ribbon', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: cols } })
      const { text, px } = await lineOf(band)
      if (px === null) {
        expect((await band.find({ key: 'row' }))?.props.height).toBe(1)
        expect(text.length).toBeLessThanOrEqual(cols - 2)
      } else {
        expect(px).toBeLessThanOrEqual((cols - 2) * 12)
      }
      expect(text).toContain('42%')
      await band.unmount()
    }
  }

  const wide = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await wide.find({ text: ' 2h 0m' })).toBeDefined()
  await wide.unmount()

  const narrow = await $.ui.mount({ plugin: 'ribbon', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 16 } })
  expect((await lineOf(narrow)).text).toBe('7D 88%  5H 42%')
  await narrow.unmount()
})

test('the band shows how full the context window is, after the usage windows', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.parse('2098-12-31T22:00:00Z') })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 74000, percent: 37 }, rateLimits: WINDOWS } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const cols of [100, 40, 24]) {
      const band = await $.ui.mount({ plugin: 'ribbon', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: cols } })
      const { text, px, source } = await lineOf(band)
      if (cols === 100) {
        expect(text).toContain('CTX')
        expect(text).toContain('37%')
        expect(text.indexOf('5H')).toBeLessThan(text.indexOf('CTX'))
        if (px !== null) expect(source).toContain('#880ed3')
      }
      if (px === null) expect(text.length).toBeLessThanOrEqual(cols - 2)
      else expect(px).toBeLessThanOrEqual((cols - 2) * 12)
      await band.unmount()
    }
  }
})
