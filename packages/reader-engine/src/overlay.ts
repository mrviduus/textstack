// SVG overlay for range-backed annotations.
// Port of https://github.com/johnfactotum/foliate-js/blob/master/overlayer.js
// (MIT, © John Factotum). Adapted to TS + our draw palette.
//
// One instance per scrolling <article>. `add(key, range, draw, options)`
// renders one annotation; `redraw()` recomputes rects after reflow.
// pointer-events:none on the SVG itself — hit-tests go through `hitTest`.
//
// Used by every annotation layer: user highlights, vocab underlines,
// TTS word sync, search matches. Anchors (Range) come from textAnchor.ts.

const SVG_NS = 'http://www.w3.org/2000/svg'

const createSVGElement = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K]

export type WritingMode = 'horizontal-tb' | 'vertical-rl' | 'vertical-lr'

export interface DrawOptions {
  color?: string
  width?: number
  radius?: number
  writingMode?: WritingMode
  src?: string
  opacity?: number
  blendMode?: string
}

export type DrawFn = (rects: DOMRectList | DOMRect[], options?: DrawOptions) => SVGElement

type RangeLike = Range | ((root: Node | Document | ShadowRoot) => Range)

export type MissReason = 'empty-rects' | 'empty-rects-redraw'

export interface OverlayerOptions {
  // Fires when a Range produces zero drawable rects (silent annotation drop).
  // Hook up to analytics to baseline miss-rate before flipping default-on.
  onMiss?: (key: string, reason: MissReason) => void
  // Fires after every redraw() pass with the current map size and any misses
  // observed in that pass. One call per reflow, so safe to log.
  onRedraw?: (info: { size: number; missCount: number }) => void
}

interface Entry {
  range: Range
  draw: DrawFn
  options?: DrawOptions
  element: SVGElement
  // Stored in DOCUMENT coords (viewport rect + scrollX/scrollY at capture
  // time). Lets SVG host stay position:fixed while rects ride document
  // scroll via a single CSS transform counter-shift (`syncScroll`).
  rects: DOMRect[]
}

// Turn a viewport-relative rect into a document-relative one so it stays
// pinned to the text across scroll events.
function toDocRect(r: DOMRect, sx: number, sy: number): DOMRect {
  return {
    x: r.x + sx,
    y: r.y + sy,
    left: r.left + sx,
    top: r.top + sy,
    right: r.right + sx,
    bottom: r.bottom + sy,
    width: r.width,
    height: r.height,
    toJSON: () => ({}),
  } as DOMRect
}

// Collapsed ranges (start-of-paragraph caret inside a text node) often return
// zero client rects. Port of foliate-js/paginator.js:39-53 — extend by one
// char before measuring. Mutates a clone so callers keep their original Range
// intact.
//
// Element-boundary collapse is NOT expanded. Our live ranges are always
// constructed with setStart/setEnd on Text nodes (textAnchor.ts,
// vocabHighlightEngine.ts), so a collapse up to an element means the stored
// text node was detached by a DOM re-render. Expanding via selectNode on the
// child would wrap the whole first block — producing hundreds of per-line
// rects that look like every line is underlined (the scroll-flicker regression
// from 2026-04-24). Dropping this frame is correct; next reflow retries.
function uncollapseForMeasure(range: Range): Range {
  if (!range.collapsed) return range
  const { endContainer } = range
  if (endContainer.nodeType === Node.ELEMENT_NODE) return range
  const clone = range.cloneRange()
  const endOffset = clone.endOffset
  const len = (endContainer as CharacterData).length
  if (endOffset + 1 <= len) clone.setEnd(endContainer, endOffset + 1)
  else if (endOffset >= 1) clone.setStart(endContainer, endOffset - 1)
  else if (endContainer.parentNode) clone.selectNode(endContainer.parentNode)
  return clone
}

function captureRects(range: Range): DOMRect[] {
  const sx = typeof window !== 'undefined' ? window.scrollX : 0
  const sy = typeof window !== 'undefined' ? window.scrollY : 0
  let raw = Array.from(range.getClientRects())
  if (raw.length === 0) {
    const fallback = uncollapseForMeasure(range)
    if (fallback !== range) raw = Array.from(fallback.getClientRects())
  }
  // Drop zero-area rects — Firefox emits them at column breaks, and any rect
  // with width=0 or height=0 cannot be hit-tested or visibly drawn anyway.
  return raw.filter((r) => r.width > 0 && r.height > 0).map((r) => toDocRect(r, sx, sy))
}

// Monotonic clock with a Date.now() fallback for hostless test envs.
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

export class Overlayer {
  readonly #svg: SVGSVGElement
  readonly #map = new Map<string, Entry>()
  readonly #onMiss?: OverlayerOptions['onMiss']
  readonly #onRedraw?: OverlayerOptions['onRedraw']
  // Port of foliate-js/view.js `justAnchored`. On annotation tap we mark a
  // short "cooldown" window; any selectionchange or synthetic click (iOS
  // Safari fires one ~300 ms after touchend) during it is ignored by the
  // consumer. Eliminates the 50/50 hit-test-vs-selection-popup race.
  #justAnchoredUntil = 0

  constructor(options: OverlayerOptions = {}) {
    this.#svg = createSVGElement('svg')
    this.#svg.setAttribute('data-reader-overlay', 'true')
    Object.assign(this.#svg.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      // UA default for outer <svg> is overflow:hidden — clips any rect whose
      // internal y exceeds svg.height. Our rects are stored in DOCUMENT coords
      // and rendered via transform:translate(-scrollX,-scrollY), so anything
      // past the first viewport (y > h) gets silently clipped → vocab/highlight
      // underlines vanish after scroll.
      overflow: 'visible',
    })
    this.#onMiss = options.onMiss
    this.#onRedraw = options.onRedraw
    this.syncScroll()
  }

  // Open the cooldown window. Default 400 ms covers iOS Safari's 300 ms
  // synthetic-mouse replay plus a small slop for slow event loops.
  markJustAnchored(ms = 400): void {
    this.#justAnchoredUntil = nowMs() + ms
  }

  isJustAnchored(): boolean {
    return nowMs() < this.#justAnchoredUntil
  }

  #reportMiss(key: string, reason: MissReason): void {
    if (!this.#onMiss) return
    try {
      this.#onMiss(key, reason)
    } catch {
      // Telemetry must never break the caller.
    }
  }

  get element(): SVGSVGElement {
    return this.#svg
  }

  get size(): number {
    return this.#map.size
  }

  has(key: string): boolean {
    return this.#map.has(key)
  }

  // Counter-translate the SVG by current scroll so document-coord rects
  // inside it land on screen where the text actually is. O(1) vs a full
  // redraw, so safe to call on every scroll frame.
  syncScroll(): void {
    const sx = typeof window !== 'undefined' ? window.scrollX : 0
    const sy = typeof window !== 'undefined' ? window.scrollY : 0
    this.#svg.style.transform = `translate(${-sx}px, ${-sy}px)`
  }

  add(key: string, range: RangeLike, draw: DrawFn, options?: DrawOptions): void {
    if (this.#map.has(key)) this.remove(key)
    const resolved = typeof range === 'function' ? range(this.#svg.getRootNode()) : range
    if (!resolved) return
    const rects = captureRects(resolved)
    if (rects.length === 0) this.#reportMiss(key, 'empty-rects')
    const element = draw(rects, options)
    this.#svg.append(element)
    this.#map.set(key, { range: resolved, draw, options, element, rects })
    this.syncScroll()
  }

  remove(key: string): void {
    const entry = this.#map.get(key)
    if (!entry) return
    if (entry.element.parentNode === this.#svg) {
      this.#svg.removeChild(entry.element)
    }
    this.#map.delete(key)
  }

  clear(): void {
    for (const key of Array.from(this.#map.keys())) this.remove(key)
  }

  redraw(): void {
    let missCount = 0
    for (const [key, entry] of this.#map.entries()) {
      const { range, draw, options, element } = entry
      if (element.parentNode === this.#svg) this.#svg.removeChild(element)
      const rects = captureRects(range)
      if (rects.length === 0) {
        missCount++
        this.#reportMiss(key, 'empty-rects-redraw')
      }
      const next = draw(rects, options)
      this.#svg.append(next)
      entry.element = next
      entry.rects = rects
    }
    this.syncScroll()
    if (this.#onRedraw) {
      try {
        this.#onRedraw({ size: this.#map.size, missCount })
      } catch {
        // Telemetry must never break the caller.
      }
    }
  }

  hitTest(point: { x: number; y: number }): [string, Range] | [] {
    // Point arrives in viewport coords (e.g. clientX/Y) but stored rects
    // are in document coords — shift the point instead of every rect.
    const sx = typeof window !== 'undefined' ? window.scrollX : 0
    const sy = typeof window !== 'undefined' ? window.scrollY : 0
    const px = point.x + sx
    const py = point.y + sy
    const entries = Array.from(this.#map.entries())
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, obj] = entries[i]
      for (const rect of obj.rects) {
        if (rect.top <= py && rect.left <= px && rect.bottom > py && rect.right > px) {
          return [key, obj.range]
        }
      }
    }
    return []
  }

  keys(): IterableIterator<string> {
    return this.#map.keys()
  }

  // --- Draw palette ---

  static highlight: DrawFn = (rects, options = {}) => {
    const { color = 'yellow', opacity = 0.3, blendMode = 'multiply' } = options
    const g = createSVGElement('g')
    // style.fill (not setAttribute) so consumers can pass `var(--x)` and
    // theme switches re-evaluate without a redraw.
    g.style.fill = color
    g.style.opacity = `var(--overlay-highlight-opacity, ${opacity})`
    g.style.mixBlendMode = `var(--overlay-highlight-blend-mode, ${blendMode})`
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

  static underline: DrawFn = (rects, options = {}) => {
    const { color = 'red', width: strokeWidth = 2, writingMode } = options
    const g = createSVGElement('g')
    g.style.fill = color
    if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr') {
      for (const { right, top, height } of rects) {
        const el = createSVGElement('rect')
        el.setAttribute('x', String(right - strokeWidth))
        el.setAttribute('y', String(top))
        el.setAttribute('height', String(height))
        el.setAttribute('width', String(strokeWidth))
        g.append(el)
      }
    } else {
      for (const { left, bottom, width } of rects) {
        const el = createSVGElement('rect')
        el.setAttribute('x', String(left))
        el.setAttribute('y', String(bottom - strokeWidth))
        el.setAttribute('height', String(strokeWidth))
        el.setAttribute('width', String(width))
        g.append(el)
      }
    }
    return g
  }

  static strikethrough: DrawFn = (rects, options = {}) => {
    const { color = 'red', width: strokeWidth = 2, writingMode } = options
    const g = createSVGElement('g')
    g.style.fill = color
    if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr') {
      for (const { right, left, top, height } of rects) {
        const el = createSVGElement('rect')
        el.setAttribute('x', String((right + left) / 2))
        el.setAttribute('y', String(top))
        el.setAttribute('height', String(height))
        el.setAttribute('width', String(strokeWidth))
        g.append(el)
      }
    } else {
      for (const { left, top, bottom, width } of rects) {
        const el = createSVGElement('rect')
        el.setAttribute('x', String(left))
        el.setAttribute('y', String((top + bottom) / 2))
        el.setAttribute('height', String(strokeWidth))
        el.setAttribute('width', String(width))
        g.append(el)
      }
    }
    return g
  }

  static squiggly: DrawFn = (rects, options = {}) => {
    const { color = 'red', width: strokeWidth = 2, writingMode } = options
    const g = createSVGElement('g')
    g.style.fill = 'none'
    g.style.stroke = color
    g.style.strokeWidth = String(strokeWidth)
    const block = strokeWidth * 1.5
    if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr') {
      for (const { right, top, height } of rects) {
        const el = createSVGElement('path')
        const n = Math.max(1, Math.round(height / block / 1.5))
        const inline = height / n
        const ls = Array.from({ length: n }, (_, i) => `l${i % 2 ? -block : block} ${inline}`).join('')
        el.setAttribute('d', `M${right} ${top}${ls}`)
        g.append(el)
      }
    } else {
      for (const { left, bottom, width } of rects) {
        const el = createSVGElement('path')
        const n = Math.max(1, Math.round(width / block / 1.5))
        const inline = width / n
        const ls = Array.from({ length: n }, (_, i) => `l${inline} ${i % 2 ? block : -block}`).join('')
        el.setAttribute('d', `M${left} ${bottom}${ls}`)
        g.append(el)
      }
    }
    return g
  }

  static outline: DrawFn = (rects, options = {}) => {
    const { color = 'red', width: strokeWidth = 3, radius = 3 } = options
    const g = createSVGElement('g')
    g.style.fill = 'none'
    g.style.stroke = color
    g.style.strokeWidth = String(strokeWidth)
    for (const { left, top, height, width } of rects) {
      const el = createSVGElement('rect')
      el.setAttribute('x', String(left))
      el.setAttribute('y', String(top))
      el.setAttribute('height', String(height))
      el.setAttribute('width', String(width))
      el.setAttribute('rx', String(radius))
      g.append(el)
    }
    return g
  }

  // TTS cursor — same shape as highlight but applies a subtle CSS animation
  // by class so consumers can customize the pulse without DOM churn.
  static pulse: DrawFn = (rects, options = {}) => {
    const { color = 'currentColor', opacity = 0.25 } = options
    const g = createSVGElement('g')
    g.style.fill = color
    g.setAttribute('class', 'reader-overlay-pulse')
    g.style.opacity = `var(--overlay-pulse-opacity, ${opacity})`
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
}
