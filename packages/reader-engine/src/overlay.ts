// The SVG draws for decorations: a filled box (highlight, search hit, selection) and an underline
// (saved word). Port of https://github.com/johnfactotum/foliate-js/blob/master/overlayer.js
// (MIT, © John Factotum), cut to the two draws the engine uses (#795).

const SVG_NS = 'http://www.w3.org/2000/svg'

const createSVGElement = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K]

export interface DrawOptions {
  color?: string
  width?: number
}

export type DrawFn = (rects: DOMRectList | DOMRect[], options?: DrawOptions) => SVGElement

export const highlight: DrawFn = (rects, options = {}) => {
  const { color = 'yellow' } = options
  const g = createSVGElement('g')
  // style.fill (not setAttribute) so consumers can pass `var(--x)` and
  // theme switches re-evaluate without a redraw.
  g.style.fill = color
  g.style.opacity = 'var(--overlay-highlight-opacity, 0.3)'
  g.style.mixBlendMode = 'var(--overlay-highlight-blend-mode, multiply)'
  for (const { left, top, height, width } of rects) {
    const el = createSVGElement('rect')
    el.setAttribute('x', String(left))
    el.setAttribute('y', String(top))
    el.setAttribute('height', String(height))
    el.setAttribute('width', String(width))
    g.append(el)
  }
  return g
}

export const underline: DrawFn = (rects, options = {}) => {
  const { color = 'red', width: strokeWidth = 2 } = options
  const g = createSVGElement('g')
  g.style.fill = color
  for (const { left, bottom, width } of rects) {
    const el = createSVGElement('rect')
    el.setAttribute('x', String(left))
    el.setAttribute('y', String(bottom - strokeWidth))
    el.setAttribute('height', String(strokeWidth))
    el.setAttribute('width', String(width))
    g.append(el)
  }
  return g
}
