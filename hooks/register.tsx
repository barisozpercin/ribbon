import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheFacts, Fold, Window } from '../types'
import {
  BG, EMPTY, HUE, INK, MUTED, VQ_PINK, TEXT, ON_VIOLET, VIOLET, stripSvg, stripW, TTL_MIN, TTL_MS, WORD, SIGN_CYAN,
  bandPx, cardSvg, costOf, familyOf, fmtIdle, kindOf, mineModel, usd,
} from './cache-art'
import type { CacheView, Piece } from './cache-art'

// A band above the prompt in a warm dark look: card surface, cream text,
// dot-matrix bars. Shows how much of each usage window is LEFT, 7-day first, then
// 5-hour; 7D is OmmaVQ pink, 5H is OmmaSign cyan, warm is Omma violet; a window under 15% adds a bold LOW.
// Always one row: as the band narrows it drops detail instead of wrapping.
//
// After the first reply it also shows the prompt cache: WARM (red)
// for an hour after the last request, then COLD (blue) with what the
// next message costs to re-cache. Zero token cost:
// it reads the engine's own figures and draws.

const CELLS = 10
const LOW_AT = 15
const TIGHT_CELLS = 6
const BUTTON_CELLS = 8
const CELL_PX = 12
const GROUP_GAP_PX = 18
const MARGIN_PX = 4
/** How often the band redraws, so the countdown and the warm-to-cold flip stay current. */
const TICK_MS = 30_000

const windows = atom({ plugin: 'ribbon', key: 'windows' } as const, [] as Window[])
const cache = atom({ plugin: 'ribbon', key: 'cache' } as const, null as CacheFacts | null)
const fold = atom({ plugin: 'ribbon', key: 'fold' } as const, null as Fold | null)

const NAMES: Record<string, string> = { seven_day: '7D', five_hour: '5H', spend_limit: 'SPEND' }
const ORDER: Record<string, number> = { seven_day: 0, five_hour: 1 }
const COLORS: Record<string, string> = { seven_day: VQ_PINK, five_hour: SIGN_CYAN }

const clean = (list: readonly Window[]): Window[] =>
  list
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
    .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9))

const filled = (left: number, cells: number): number => Math.max(0, Math.min(cells, Math.round((left / 100) * cells)))
const dots = (left: number, cells: number): { on: string; off: string } => {
  const n = filled(left, cells)
  return { on: '●'.repeat(n), off: '·'.repeat(cells - n) }
}

const fmtReset = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resetting'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** What the cache drawings read, or null until a request and its context size are known. */
export const viewOf = (c: CacheFacts | null, now: number): CacheView | null => {
  if (!c || c.lastAt <= 0 || c.tokens <= 0) return null
  const idleMs = Math.max(0, now - c.lastAt)
  return {
    mode: idleMs >= TTL_MS ? 'cold' : 'warm',
    idle: fmtIdle(idleMs),
    idleMin: Math.floor(idleMs / 60000),
    tokens: c.tokens,
    window: c.window,
    mine: familyOf(c.model),
  }
}

const pull = async ($: EngineInterface): Promise<void> => {
  const u = await $.session.usage()
  await update($, windows, () => clean(u.rateLimits))
}

/** Fresh context figures from the engine onto the cache facts, when it has them. */
const measure = async ($: EngineInterface, lastAt: number | null, model: string | null): Promise<void> => {
  const u = await $.session.usage()
  const m = model ?? (await $.session.model())
  await update($, cache, c => ({
    lastAt: lastAt ?? c?.lastAt ?? 0,
    tokens: u.context.tokens && u.context.tokens > 0 ? u.context.tokens : (c?.tokens ?? 0),
    window: u.context.window || c?.window || 0,
    model: m || c?.model || null,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await pull($)
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, windows, () => clean(e.rateLimits))
    }
    if (e.changed.includes('context') && e.context.tokens && e.context.tokens > 0) {
      const tokens = e.context.tokens
      await update($, cache, c => (c ? { ...c, tokens, window: e.context.window || c.window } : c))
    }
    return next(e)
  })

  // A resumed or forked session knows how long it was away and how big it is.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear' || e.source === 'compact') {
      await update($, cache, () => null)
      await update($, fold, () => null)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const now = await $.clock.now()
      const lastAt = now - e.seconds_since_last_response * 1000
      const window = (await $.session.usage()).context.window
      const model = typeof e.model === 'string' ? e.model : await $.session.model()
      const tokens = typeof e.context_tokens === 'number' ? e.context_tokens : 0
      await update($, cache, () => ({ lastAt, tokens, window, model }))
    }
    return r
  }).catch(($, e, next) => next(e)) // a band that fails to seed never holds up the session

  // Each main-thread request reads or writes the cache, so its start resets the hour.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, cache, c => ({ lastAt: now, tokens: c?.tokens ?? 0, window: c?.window ?? 0, model: c?.model ?? null }))
    }
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    const c = await read($, cache)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    const lastAt = !c || now - c.lastAt > e.durationMs ? now : c.lastAt
    await measure($, lastAt, e.usage?.model ?? null)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Svg draws on desktop, mobile and VS Code; the terminal gets the text form.
    // Ask the surface, not the table: the terminal's table still lists Svg.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const list = await read($, windows)
    const now = await $.clock.now()
    const view = viewOf(await read($, cache), now)

    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100

    type Seg = { t: string; color?: string; bold?: boolean; bg?: string }
    const width = (segs: Seg[]): number => segs.reduce((n, s) => n + s.t.length, 0)

    const winSegs = (w: Window, level: number): Seg[] => {
      const left = Math.max(0, Math.round(100 - w.percentUsed))
      const col = COLORS[w.kind] ?? TEXT
      const segs: Seg[] = [{ t: `${NAMES[w.kind] ?? w.kind.toUpperCase()} `, color: MUTED, bold: true }]
      if (level <= 2) {
        const d = dots(left, level === 0 ? CELLS : TIGHT_CELLS)
        segs.push({ t: d.on, color: col }, { t: d.off, color: EMPTY }, { t: ' ' })
      }
      segs.push({ t: `${left}%`, color: col, bold: true })
      if (left < LOW_AT) segs.push({ t: level <= 1 ? ' LOW' : '!', color: TEXT, bold: true })
      const reset = level <= 1 ? fmtReset(w.resetsAt, now) : ''
      if (reset) segs.push({ t: ` ${reset}`, color: MUTED })
      return segs
    }

    const mode = view?.mode ?? 'warm'
    const cold = mode === 'cold'
    const hue = HUE[mode]
    const mine = view ? mineModel(view) : undefined
    const minsLeft = view ? Math.max(0, TTL_MIN - view.idleMin) : 0
    const price = view && mine ? usd(costOf(mine, mode, view.tokens)) : ''

    const cacheSegs = (level: number): Seg[] => {
      if (!view) return []
      if (level === 0) {
        const chip: Seg = cold
          ? { t: ` ${WORD[mode]} `, bg: hue, color: INK, bold: true }
          : { t: ` ${WORD[mode]} `, bg: VIOLET, color: ON_VIOLET, bold: true }
        if (!cold) return [chip, { t: ` ${minsLeft}m`, color: hue, bold: true }]
        return price
          ? [chip, { t: ` ${view.idle}`, color: hue, bold: true }, { t: ' · ', color: MUTED }, { t: price, color: TEXT, bold: true }]
          : [chip, { t: ` ${view.idle}`, color: hue, bold: true }]
      }
      const dot: Seg = { t: '●', color: hue }
      if (level === 2) return [dot]
      if (!cold) return [dot, { t: ` ${minsLeft}m`, color: hue, bold: true }]
      return [dot, price ? { t: ` ${price}`, color: TEXT, bold: true } : { t: ` ${view.idle}`, color: hue, bold: true }]
    }

    const winPieces = (w: Window, level: number): Piece[] => {
      const left = Math.max(0, Math.round(100 - w.percentUsed))
      const col = COLORS[w.kind] ?? TEXT
      const ps: Piece[] = [
        { k: 'text', s: NAMES[w.kind] ?? w.kind.toUpperCase(), face: 'D500', size: 11, fill: MUTED, ls: 0.88 },
        { k: 'gap', w: 6 },
      ]
      if (level <= 2) {
        const cells = level === 0 ? CELLS : TIGHT_CELLS
        const n = filled(left, cells)
        ps.push({ k: 'dots', on: n, off: cells - n, fill: col }, { k: 'gap', w: 7 })
      }
      ps.push({ k: 'text', s: `${left}%`, face: 'M600', size: 13, fill: col })
      if (left < LOW_AT) ps.push({ k: 'gap', w: 4 }, { k: 'text', s: level <= 1 ? 'LOW' : '!', face: 'M700', size: 11, fill: TEXT })
      const reset = level <= 1 ? fmtReset(w.resetsAt, now) : ''
      if (reset) ps.push({ k: 'gap', w: 7 }, { k: 'text', s: reset, face: 'D500', size: 12, fill: MUTED })
      return ps
    }

    const cachePieces = (level: number): Piece[] => {
      if (!view) return []
      const big = (str: string, fill: string, face: 'M600' | 'M700' = 'M600'): Piece => ({ k: 'text', s: str, face, size: 13, fill })
      if (level === 0) {
        const chip: Piece = cold
          ? { k: 'chip', word: WORD[mode], fill: hue, ink: INK }
          : { k: 'chip', word: WORD[mode], fill: VIOLET, ink: ON_VIOLET }
        if (!cold) return [chip, { k: 'gap', w: 7 }, big(`${minsLeft}m`, hue)]
        const ps: Piece[] = [chip, { k: 'gap', w: 7 }, big(view.idle, hue)]
        if (price) ps.push({ k: 'gap', w: 6 }, { k: 'text', s: '·', face: 'M600', size: 13, fill: MUTED }, { k: 'gap', w: 6 }, big(price, TEXT, 'M700'))
        return ps
      }
      const dot: Piece = { k: 'dot', fill: hue }
      if (level === 2) return [dot]
      if (!cold) return [dot, { k: 'gap', w: 6 }, big(`${minsLeft}m`, hue)]
      return [dot, { k: 'gap', w: 6 }, price ? big(price, TEXT, 'M700') : big(view.idle, hue)]
    }

    const GAP = '  '
    const lowest = list.reduce<Window[]>((a, w) => (a.length && a[0].percentUsed >= w.percentUsed ? a : [w]), [])
    const line = (win: number, cacheLevel: number | null): Seg[] => {
      const groups = (win === 4 ? lowest : list).map(w => winSegs(w, Math.min(win, 3)))
      if (cacheLevel !== null && view) groups.push(cacheSegs(cacheLevel))
      if (groups.length === 0) groups.push([{ t: 'waiting for the first reply', color: MUTED }])
      return groups.flatMap((g, i) => (i === 0 ? g : [{ t: GAP }, ...g]))
    }
    const linePieces = (win: number, cacheLevel: number | null): Piece[] => {
      const groups = (win === 4 ? lowest : list).map(w => winPieces(w, Math.min(win, 3)))
      if (cacheLevel !== null && view) groups.push(cachePieces(cacheLevel))
      if (groups.length === 0) groups.push([{ k: 'text', s: 'waiting for the first reply', face: 'D500', size: 12, fill: MUTED }])
      return groups.flatMap((g, i): Piece[] => (i === 0 ? g : [{ k: 'gap', w: GROUP_GAP_PX }, ...g]))
    }

    const canFold = Svg !== null && view !== null
    const PLANS: Array<[number, number | null, boolean]> = [
      [0, 0, true], [1, 0, true], [1, 1, true], [2, 1, true], [3, 1, true], [3, 2, true], [3, 2, false], [3, null, false], [4, null, false],
    ]
    const room = columns - 2
    const fits = ([w, c, b]: [number, number | null, boolean]): boolean =>
      Svg
        ? stripW(linePieces(w, c)) + (canFold && b ? BUTTON_CELLS * CELL_PX : 0) <= room * CELL_PX
        : width(line(w, c)) + (canFold && b ? BUTTON_CELLS : 0) <= room
    const plan = PLANS.find(fits) ?? PLANS[PLANS.length - 1]
    const [winLevel, cacheLevel, wantsButton] = plan
    const segs = line(winLevel, cacheLevel)
    const showButton = canFold && wantsButton

    const stored = await read($, fold)
    const open = showButton && stored !== null && stored.mode === mode && stored.open
    const toggle = () => update($, fold, f => ({ mode, open: !(f && f.mode === mode && f.open) }))

    const strip = Svg ? stripSvg(linePieces(winLevel, cacheLevel), MARGIN_PX) : null
    const rows = (
      <Box key="row" flexDirection="row" paddingX={1} alignItems="center" {...(Svg ? {} : { height: 1, overflow: 'hidden' as const })}>
        {Svg && strip ? (
          <Box key="line" flexShrink={1}>
            <Svg source={strip.source} alt={segs.map(s => s.t).join('').trim()} width={strip.w} height={strip.h} />
          </Box>
        ) : (
          <Box key="line" flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              {segs.map((s, i) => (
                <Text key={`s-${i}`} color={s.color} bold={s.bold} backgroundColor={s.bg}>{s.t}</Text>
              ))}
            </Text>
          </Box>
        )}
        {Svg ? <Box key="grow" flexGrow={1} /> : null}
        {showButton ? (
          <Box key="fold" flexShrink={0}>
            <Button key="cache-fold" label={open ? 'Hide' : 'Show'} onPress={toggle} />
          </Box>
        ) : null}
      </Box>
    )

    let card = null
    if (open && Svg && view) {
      const kind = kindOf(columns)
      const c = cardSvg(view, kind, bandPx(columns))
      card = (
        <Box key="card" flexDirection="row">
          <Svg source={c.source} alt={c.alt} width={c.w} height={c.h} isInteractive={kind !== 'tight'} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" backgroundColor={BG}>
        {rows}
        {card}
      </Box>
    )
  })
}
