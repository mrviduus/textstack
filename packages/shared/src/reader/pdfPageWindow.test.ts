import { describe, it, expect } from 'vitest'
import {
  pagesInRange,
  computePageRings,
  topVisiblePage,
  clampPage,
  resolveOpenPage,
  dimsReadyUpTo,
  pageAtViewportTop,
} from './pdfPageWindow'

describe('pagesInRange', () => {
  it('expands each visible page by the radius', () => {
    expect([...pagesInRange([5], 1, 100)].sort((a, b) => a - b)).toEqual([4, 5, 6])
  })

  it('clamps to [1, numPages]', () => {
    expect([...pagesInRange([1], 2, 3)].sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect([...pagesInRange([3], 2, 3)].sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('merges overlapping ranges without duplicates', () => {
    expect([...pagesInRange([2, 3], 1, 10)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  it('returns empty for no visible pages', () => {
    expect(pagesInRange([], 2, 10).size).toBe(0)
  })
})

describe('computePageRings', () => {
  it('render ring is ±1, keep ring is ±2', () => {
    const { render, keep } = computePageRings([10], 100)
    expect([...render].sort((a, b) => a - b)).toEqual([9, 10, 11])
    expect([...keep].sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12])
  })

  it('render ring is a subset of keep ring', () => {
    const { render, keep } = computePageRings([3, 4], 50)
    for (const p of render) expect(keep.has(p)).toBe(true)
  })
})

describe('topVisiblePage', () => {
  it('returns the smallest visible page', () => {
    expect(topVisiblePage([7, 5, 9], 1)).toBe(5)
  })

  it('falls back when nothing is visible', () => {
    expect(topVisiblePage([], 42)).toBe(42)
  })
})

describe('clampPage', () => {
  it('clamps overflow to numPages (stale/deep jump does not strand at top)', () => {
    expect(clampPage(999, 100)).toBe(100)
  })

  it('clamps below 1 up to 1', () => {
    expect(clampPage(0, 100)).toBe(1)
    expect(clampPage(-5, 100)).toBe(1)
  })

  it('floors to >= 1 when the page count is not known yet', () => {
    expect(clampPage(37, 0)).toBe(37)
    expect(clampPage(0, 0)).toBe(1)
  })

  it('returns 1 for non-finite input', () => {
    expect(clampPage(NaN, 100)).toBe(1)
  })
})

describe('resolveOpenPage', () => {
  it('the chapter page (initialPage) wins over the resume page', () => {
    expect(resolveOpenPage(12, 40)).toBe(12)
  })

  it('falls back to the resume page when there is no chapter page', () => {
    expect(resolveOpenPage(null, 40)).toBe(40)
  })

  it('defaults to page 1 when neither is set', () => {
    expect(resolveOpenPage(null, null)).toBe(1)
    expect(resolveOpenPage(undefined, undefined)).toBe(1)
  })

  it('precedence: chapter page > server resume > localStorage > 1', () => {
    // chapter page wins over both resume sources
    expect(resolveOpenPage(12, 40, 7)).toBe(12)
    // no chapter → server resume page wins over localStorage
    expect(resolveOpenPage(null, 40, 7)).toBe(40)
    // no chapter, no server → localStorage
    expect(resolveOpenPage(null, null, 7)).toBe(7)
    // nothing → 1
    expect(resolveOpenPage(null, null, null)).toBe(1)
    // skips <1 candidates
    expect(resolveOpenPage(0, 40, 7)).toBe(40)
  })
})

describe('dimsReadyUpTo', () => {
  it('is false while heights above the target are still streaming in', () => {
    const dims = [{ w: 1, h: 1 }, undefined, undefined, { w: 1, h: 1 }]
    expect(dimsReadyUpTo(dims, 3)).toBe(false)
  })

  it('is true once every page up to the target has a dim', () => {
    const dims = [{ w: 1, h: 1 }, { w: 1, h: 1 }, { w: 1, h: 1 }, undefined]
    expect(dimsReadyUpTo(dims, 3)).toBe(true)
  })

  it('is false for an empty dims array', () => {
    expect(dimsReadyUpTo([], 1)).toBe(false)
  })

  it('does not require dims beyond the array length', () => {
    const dims = [{ w: 1, h: 1 }]
    expect(dimsReadyUpTo(dims, 5)).toBe(true)
  })
})

// pdfio.cjs geometry: 1250px pages, 16px gap, viewport top at 0. The render
// observer's 300px rootMargin keeps page 39 "visible" while its bottom sits
// just above the viewport — min(visible) said 39 for a reader on 40 (C3).
const rect = (page: number, top: number) => ({ page, top, bottom: top + 1250 })

describe('pageAtViewportTop (C3)', () => {
  it('opened at 40 (page top on the viewport top) → 40, not the page above', () => {
    expect(pageAtViewportTop([rect(39, -1266), rect(40, 0), rect(41, 1266)], 0)).toBe(40)
  })

  it('stable across reopen: subpixel jump alignment still reads 40', () => {
    expect(pageAtViewportTop([rect(39, -1265.5), rect(40, 0.5), rect(41, 1266.5)], 0)).toBe(40)
    expect(pageAtViewportTop([rect(39, -1266.5), rect(40, -0.5), rect(41, 1265.5)], 0)).toBe(40)
  })

  it('mid-page: the page under the top line', () => {
    expect(pageAtViewportTop([rect(39, -1100), rect(40, 166)], 0)).toBe(39)
  })

  it('top line in the gap between pages → the next page', () => {
    expect(pageAtViewportTop([rect(39, -1258), rect(40, 8)], 0)).toBe(40)
  })

  it('order of input does not matter; nothing → null', () => {
    expect(pageAtViewportTop([rect(41, 1266), rect(40, 0), rect(39, -1266)], 0)).toBe(40)
    expect(pageAtViewportTop([], 0)).toBeNull()
  })

  it('non-zero viewport top (rects are client coords)', () => {
    expect(pageAtViewportTop([rect(39, 100 - 1266), rect(40, 100)], 100)).toBe(40)
  })
})
