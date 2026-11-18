import { describe, expect, it } from 'vitest'
import { EDGE_SHARE, tapAction } from './tapZone.mjs'

const W = 1000
const tap = (x: number | undefined, extra: { flow?: 'paginated' | 'scrolled'; dir?: 'ltr' | 'rtl'; width?: number } = {}) =>
  tapAction({ x, width: W, flow: 'paginated', ...extra })

describe('tapAction', () => {
  it('paginated_LeftEdgePrev_RightEdgeNext_CentreToggles', () => {
    expect(tap(0)).toBe('prev')
    expect(tap(W * EDGE_SHARE - 1)).toBe('prev')
    expect(tap(W * EDGE_SHARE)).toBe('toggle')
    expect(tap(W / 2)).toBe('toggle')
    expect(tap(W * (1 - EDGE_SHARE))).toBe('toggle')
    expect(tap(W * (1 - EDGE_SHARE) + 1)).toBe('next')
    expect(tap(W)).toBe('next')
  })

  it('rtlBook_EdgesTurnedRound', () => {
    expect(tap(10, { dir: 'rtl' })).toBe('next')
    expect(tap(W - 10, { dir: 'rtl' })).toBe('prev')
    expect(tap(W / 2, { dir: 'rtl' })).toBe('toggle')
  })

  it('scrolledFlow_EveryTapToggles', () => {
    expect(tap(10, { flow: 'scrolled' })).toBe('toggle')
    expect(tap(W - 10, { flow: 'scrolled' })).toBe('toggle')
  })

  it('noCoordinatesOrNoWidth_Toggles_NeverTurns', () => {
    expect(tap(undefined)).toBe('toggle')
    expect(tap(Number.NaN)).toBe('toggle')
    expect(tap(10, { width: 0 })).toBe('toggle')
  })
})
