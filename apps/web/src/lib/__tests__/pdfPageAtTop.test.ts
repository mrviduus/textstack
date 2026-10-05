import { describe, it, expect } from 'vitest'
import { pageAtViewportTop } from '../pdfPageAtTop'

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
