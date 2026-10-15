// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { highlight, underline } from './overlay'

// The two draws the engine paints with. Where they land on real text: E13 / E18 in decorations.test.ts.
describe('draws', () => {
  const rects = [{ left: 10, top: 20, right: 60, bottom: 40, width: 50, height: 20, x: 10, y: 20, toJSON: () => ({}) } as DOMRect]

  it('highlight yields <g> with one <rect> per input', () => {
    const g = highlight(rects, { color: '#ff0' })
    expect(g.tagName.toLowerCase()).toBe('g')
    expect(g.style.fill).toMatch(/^(#ff0|rgb\(255,\s*255,\s*0\))$/)
    expect(g.querySelectorAll('rect')).toHaveLength(1)
  })

  it('underline draws at bottom - strokeWidth', () => {
    const g = underline(rects, { color: '#00f', width: 3 })
    const rect = g.querySelector('rect')!
    expect(Number(rect.getAttribute('y'))).toBe(40 - 3)
    expect(Number(rect.getAttribute('height'))).toBe(3)
  })
})
