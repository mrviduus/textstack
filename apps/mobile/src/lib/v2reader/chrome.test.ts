import { describe, expect, it } from 'vitest'
import { BAR_PRESS_GRACE_MS, LONG_PRESS_MS, PAIR_MS, backAction, createTouchTracker, hidesBarsOnRelocate, tapAction } from './chrome.mjs'

const W = 400
const tap = (x: number | null, more: Partial<Parameters<typeof tapAction>[0]> = {}) =>
  tapAction({ kind: 'tap', x, width: W, flow: 'paginated', ...more })

describe('v2 reader tap zones (#1263)', () => {
  it('paginated_EdgesTurn_CentreToggles', () => {
    expect(tap(10)).toBe('prev')
    expect(tap(99)).toBe('prev')
    expect(tap(200)).toBe('toggle')
    expect(tap(301)).toBe('next')
    expect(tap(390)).toBe('next')
  })

  it('wordOrLink_NeverTurns', () => {
    expect(tap(390, { kind: 'word' })).toBe('none')
    expect(tap(10, { kind: 'openLink' })).toBe('none')
  })

  it('tapDismissingASelection_NeverTurns', () => {
    expect(tap(390, { selection: true })).toBe('none')
    expect(tap(200, { selection: true })).toBe('none')
  })

  it('scrolledFlow_NoZones_Toggles', () => {
    expect(tap(390, { flow: 'scrolled' })).toBe('toggle')
    expect(tap(10, { flow: null })).toBe('toggle')
  })

  it('unknownPlace_Toggles', () => {
    expect(tap(null)).toBe('toggle')
    expect(tap(390, { width: 0 })).toBe('toggle')
  })

  it('rtl_LeftEdgeIsNext', () => {
    expect(tap(10, { rtl: true })).toBe('next')
    expect(tap(390, { rtl: true })).toBe('prev')
  })
})

describe('v2 reader touch tracker', () => {
  it('pairsTheTapWithTheTouchJustEnded', () => {
    const t = createTouchTracker()
    t.start(350, 0)
    t.end(350, 80)
    expect(t.take(120)).toEqual({ x: 350, selection: false })
    expect(t.take(130)).toEqual({ x: null, selection: false }) // taken once
  })

  it('staleTouch_NoPlace', () => {
    const t = createTouchTracker()
    t.start(350, 0)
    t.end(350, 80)
    expect(t.take(80 + PAIR_MS + 1).x).toBeNull()
  })

  it('longPress_NextTapDismissesTheSelection_OnlyThatOne', () => {
    const t = createTouchTracker()
    t.start(200, 0)
    t.end(200, LONG_PRESS_MS) // a long press: a selection may be up, and the page posts nothing for it
    t.start(390, 2000)
    t.end(390, 2050)
    expect(t.take(2060)).toEqual({ x: 390, selection: true })
    t.start(390, 3000)
    t.end(390, 3050)
    expect(t.take(3060)).toEqual({ x: 390, selection: false })
  })
})

describe('v2 reader bars on relocate', () => {
  it('scrolledFlow_ReaderMoved_Hides', () => {
    expect(hidesBarsOnRelocate({ flow: 'scrolled', moved: true, msSinceBarPress: Infinity })).toBe(true)
  })

  it('paginated_OrNotMoved_OrBarControlJustPressed_Keeps', () => {
    expect(hidesBarsOnRelocate({ flow: 'paginated', moved: true, msSinceBarPress: Infinity })).toBe(false)
    expect(hidesBarsOnRelocate({ flow: 'scrolled', moved: false, msSinceBarPress: Infinity })).toBe(false)
    expect(hidesBarsOnRelocate({ flow: 'scrolled', moved: true, msSinceBarPress: BAR_PRESS_GRACE_MS - 1 })).toBe(false)
  })
})

describe('v2 reader Android back order (#1264)', () => {
  it('offerFirst_ThenTheBook_ThenTheRoute', () => {
    expect(backAction({ offer: true, reading: true })).toBe('close-offer')
    expect(backAction({ offer: true, reading: false })).toBe('close-offer')
    expect(backAction({ offer: false, reading: true })).toBe('close-book')
    expect(backAction({ offer: false, reading: false })).toBe('leave')
  })
})
