// Engine core, reflow (ADR-025): renders a chapter into the host's container, keeps the reader's place
// in the text across ops, style changes and late layout, and says why the place changed.
//
// - Every open / goTo / setStyle emits exactly one `relocated` with its opId before it resolves; a
//   newer open / goTo makes an older one resolve 'superseded' (ADR-019 rule 3: land on the ack).
// - Only user input after the last op settled is `reason: 'scroll'` (rule 7). Our own scroll's echo
//   is recognised by its scrollTop, not by a pixel tolerance.
// - While an op or a re-anchor is in flight, the place is its target, never the half-moved view
//   (rule 8): `current()`, a style change and a reflow all use it.
// - Decorations (highlights, search hits, saved words and their translations) are drawn on an SVG
//   beside the chapter, never in it: the chapter's text nodes are never changed. Redrawn whenever the
//   text may have moved (open, style, reflow).
import type { ChapterDoc, EngineEvents, EngineOptions, GoToResult, Locator, Reason, ReaderEngine, Rect, Style } from './api'
import { Overlayer, type DrawFn } from './overlay'
import { resolveLocator, type Resolved } from './resolve'
import { findTextOffsets } from './textWalker'
import { chapterText, locatorAt, matchWords, quoteAt, rangesIn, textNodes } from './text'

/** A quarter down the viewport: where both apps capture, so a position means the same place on each. */
const READING_LINE = 0.25

/** Inline elements share their block's box; a text node is placed by its nearest non-inline ancestor. */
const INLINE = new Set('A ABBR B BDI BDO BR CITE CODE DATA DEL DFN EM FONT I IMG INS KBD MARK Q S SAMP SMALL SPAN STRONG SUB SUP TIME TT U VAR'.split(' '))

/** Characters of text either side of a `find` match, like the web drawer's list. */
const FIND_CONTEXT = 40

/** A run of the chapter's text inside one block, with the chapter offset it starts at. */
interface Segment { el: Element; start: number; length: number }

/** A decoration resolved in the open chapter. Words are drawn but not tapped (ADR-025: hold selects them). */
interface Mark { group: 'highlight' | 'search' | 'word'; id: string; start: number; end: number; color?: string; translation?: string; rects: Rect[] }
type Group = 'highlight' | 'search'
type DecorationItem = Parameters<ReaderEngine['decorate']>[1][number]
type WordItem = Parameters<ReaderEngine['markWords']>[0][number]

const COLORS = {
  highlight: 'var(--reader-highlight, rgba(254, 240, 138, 0.5))',
  search: 'var(--reader-search, rgba(250, 204, 21, 0.35))',
  word: 'var(--reader-word, rgba(59, 130, 246, 0.5))',
}
const DRAW: Record<Mark['group'], DrawFn> = { highlight: Overlayer.highlight, search: Overlayer.highlight, word: Overlayer.underline }
const SVG = 'http://www.w3.org/2000/svg'

/** Selection, footer and the remaining events arrive in slice 6. */
export type EngineCore = Pick<ReaderEngine, 'open' | 'goTo' | 'setStyle' | 'current' | 'on' | 'destroy' | 'decorate' | 'markWords' | 'find'>

export function createEngine(root: HTMLElement, opts: EngineOptions = {}): EngineCore {
  const doc = root.ownerDocument
  const win = doc.defaultView!
  const page = doc.scrollingElement as HTMLElement
  const scroller = opts.scroller ?? page
  const measure = opts.measure ?? ((el: Element) => {
    const r = el.getBoundingClientRect()
    const origin = scroller === page ? 0 : scroller.getBoundingClientRect().top
    return { top: r.top - origin + scroller.scrollTop, height: r.height }
  })
  const viewport = opts.viewport ?? (() => ({ height: scroller === page ? win.innerHeight : scroller.clientHeight }))
  const schedule = opts.schedule ?? ((cb: () => void) => { win.requestAnimationFrame(() => cb()) })
  const observeResize = opts.observeResize ?? ((el: Element, cb: () => void) => {
    const ro = new win.ResizeObserver(() => cb())
    ro.observe(el)
    return () => ro.disconnect()
  })
  const fontsReady = opts.fontsReady ?? (() => doc.fonts ? doc.fonts.ready.then(() => {}) : Promise.resolve())
  const rectsOf = opts.rects ?? ((range: Range): Rect[] => {
    const o = root.getBoundingClientRect()
    return Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.left - o.left, y: r.top - o.top, width: r.width, height: r.height }))
  })
  const frame = () => new Promise<void>((r) => schedule(r))

  const content = doc.createElement('div')
  // Beside the chapter, in its coordinates: scrolls with the text, never read as text (gloss marker).
  const layer = doc.createElementNS(SVG, 'svg')
  layer.setAttribute('data-vocab-overlay', 'true')   // in READER_GLOSS_SELECTOR: text.ts skips it
  layer.setAttribute('aria-hidden', 'true')
  Object.assign(layer.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' })
  const rootPosition = root.style.position
  if (['static', ''].includes(win.getComputedStyle(root).position)) root.style.position = 'relative'
  root.replaceChildren(content, layer)
  const fontFaces = doc.createElement('style')

  let alive = true
  let opened = false
  let href: string | undefined
  let text = ''
  let segments: Segment[] = []
  let docSeq = 0                         // open: a newer one replaces the document
  let moveSeq = 0                        // open / goTo: a newer one supersedes an older
  let styleSeq = 0
  let target: Locator | null = null      // where the open / goTo in flight will land
  let styleAnchor: Locator | null = null // where the setStyle in flight will re-anchor
  let last: Locator | null = null        // the place a reflow keeps
  let ownTop: number | null = null       // the scrollTop we set; its scroll event is not reading
  let height = -1
  let scrollQueued = false
  const decorations: Record<Group, DecorationItem[]> = { highlight: [], search: [] }
  let words: WordItem[] = []
  let showTranslations = false
  let marks: Mark[] = []
  const listeners = new Map<keyof EngineEvents, Set<(p: never) => void>>()

  function emit<K extends keyof EngineEvents>(e: K, p: EngineEvents[K]) {
    for (const cb of [...(listeners.get(e) ?? [])]) (cb as (p: EngineEvents[K]) => void)(p)
  }

  function segmentsOf(el: Element): Segment[] {
    const out: Segment[] = []
    let at = 0
    for (const t of textNodes(el)) {
      // Whitespace between blocks has no line of its own; a segment for it would claim the container's box.
      if (t.data.trim()) {
        let block = t.parentElement!
        while (block !== el && INLINE.has(block.tagName)) block = block.parentElement!
        const prev = out[out.length - 1]
        if (prev?.el === block && prev.start + prev.length === at) prev.length += t.length
        else out.push({ el: block, start: at, length: t.length })
      }
      at += t.length
    }
    // ponytail: text beside a child block (`<li>Intro <p>…</p></li>`) is placed across the parent's
    // whole box, so the reading line there is approximate; per-line rects if it matters.
    return out
  }

  /** The chapter offset at content y. Linear in the block's height: the same map both ways. */
  function offsetAtY(y: number): number {
    const box = measure(content)
    y = Math.max(box.top, Math.min(y, box.top + box.height - 1))
    let hit: { s: Segment; m: { top: number; height: number } } | undefined
    let above: Segment | undefined
    for (const s of segments) {
      const m = measure(s.el)
      // Innermost wins: a parent block's box holds its children's (ties: the later, deeper one).
      if (m.top <= y && y < m.top + m.height) { if (!hit || m.height <= hit.m.height) hit = { s, m } }
      else if (m.top + m.height <= y) above = s
    }
    // ponytail: linear scan of every block per capture; binary search on block tops if long chapters stutter.
    if (!hit) return above ? above.start + above.length : 0
    const { s, m } = hit
    return s.start + Math.min(s.length - 1, Math.floor(((y - m.top) / m.height) * s.length + 1e-6))
  }

  /** Content y of a chapter offset; an offset between blocks is the top of the next one. */
  function yAtOffset(offset: number): number {
    const seg = segments.find((s) => offset < s.start + s.length) ?? segments[segments.length - 1]
    if (!seg) return 0
    const m = measure(seg.el)
    return m.top + (Math.max(0, Math.min(offset - seg.start, seg.length)) / seg.length) * m.height
  }

  function progression(): number {
    const max = scroller.scrollHeight - viewport().height
    return max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0
  }

  /** The reader's place right now, read off the reading line. */
  function capture(): Locator {
    const at = offsetAtY(scroller.scrollTop + READING_LINE * viewport().height)
    return (href && locatorAt(text, at, href, progression())) || { href, type: 'text/html', locations: { progression: progression() } }
  }

  /** Rule 8: the target in flight, or the reading line when nothing is. */
  const here = () => target ?? styleAnchor ?? capture()

  function scrollTo(y: number) {
    scroller.scrollTop = Math.max(0, y)
    ownTop = scroller.scrollTop
  }

  function topFor(r: Resolved, line: number): number {
    switch (r.result) {
      case 'exact':
      case 'fuzzy': return yAtOffset(r.offset) - line * viewport().height
      case 'fraction': return r.fraction * (scroller.scrollHeight - viewport().height)
      case 'legacyOffset': return r.scrollY
      case 'start': return 0
    }
  }

  /**
   * Scrolls to a locator and makes it the place a reflow keeps. Text that was found is reported as
   * itself, even when the scroll stops short of the line (chapter top or end); null: another chapter.
   */
  function land(loc: Locator | null, line = READING_LINE): GoToResult | null {
    const r = resolveLocator(loc, href, text)
    if (!r) return null
    scrollTo(topFor(r, line))
    const found = (r.result === 'exact' || r.result === 'fuzzy') && href ? locatorAt(text, r.offset, href, progression()) : null
    last = found ?? capture()
    height = measure(content).height
    return r.result
  }

  /** The op landed: one relocated with the landed place. */
  function settle(reason: Reason, opId: string | undefined, result: GoToResult): GoToResult {
    target = null
    emit('relocated', { locator: last!, reason, opId })
    return result
  }

  function superseded(reason: Reason, opId: string | undefined): GoToResult {
    emit('relocated', { locator: here(), reason, opId })
    return 'superseded'
  }

  function miss(loc: Locator) {
    emit('error', { code: 'anchor-miss', detail: `locator is for chapter ${loc.href ?? '(none)'}, open is ${href ?? '(none)'}` })
  }

  /** Where every decoration stands in the open chapter's text; another chapter's, or a lost quote, has no place. */
  function resolveMarks() {
    marks = []
    for (const group of ['search', 'highlight'] as const) {
      for (const d of decorations[group]) {
        const r = resolveLocator(d.locator, href, text)
        const length = d.locator.text?.highlight?.length ?? 0
        if (r && (r.result === 'exact' || r.result === 'fuzzy') && length) {
          marks.push({ group, id: d.id, start: r.offset, end: r.offset + length, color: d.style, rects: [] })
        }
      }
    }
    for (const m of matchWords(content, words)) {
      marks.push({ group: 'word', id: m.item.word, start: m.start, end: m.end, color: m.item.style, translation: m.item.translation, rects: [] })
    }
  }

  /** Draws every mark where its text is now. */
  function paint() {
    layer.replaceChildren()
    if (!marks.length) return
    const rangeAt = rangesIn(content)
    const scratch = doc.createRange()   // marks keep rects, not ranges
    for (const m of marks) {
      const range = rangeAt(m.start, m.end - m.start, scratch)
      m.rects = range ? rectsOf(range) : []
      const boxes = m.rects.map((r) => ({ ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height })) as unknown as DOMRect[]
      const g = DRAW[m.group](boxes, { color: m.color ?? COLORS[m.group] })
      g.setAttribute('data-group', m.group)
      g.setAttribute('data-id', m.id)
      layer.append(g)
      const first = m.rects[0]
      if (m.translation && showTranslations && first) {
        const label = doc.createElementNS(SVG, 'text')
        label.setAttribute('class', 'reader-translation')
        label.setAttribute('x', String(first.x + first.width / 2))
        label.setAttribute('y', String(first.y))
        label.setAttribute('text-anchor', 'middle')
        label.setAttribute('fill', 'currentColor')   // the theme's text colour (root's `color`)
        label.textContent = m.translation
        layer.append(label)
      }
    }
  }

  const redraw = () => { resolveMarks(); paint() }

  /** A tap on a highlight or search hit (highlights on top); the last drawn wins inside a group. */
  function onClick(e: MouseEvent) {
    if (doc.getSelection()?.isCollapsed === false) return   // the end of a drag selection, not a tap
    const o = root.getBoundingClientRect()
    const x = e.clientX - o.left
    const y = e.clientY - o.top
    for (const group of ['highlight', 'search'] as const) {
      for (let i = marks.length - 1; i >= 0; i--) {
        const m = marks[i]
        if (m.group !== group || !m.rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue
        const left = Math.min(...m.rects.map((r) => r.x))
        const top = Math.min(...m.rects.map((r) => r.y))
        const width = Math.max(...m.rects.map((r) => r.x + r.width)) - left
        const height = Math.max(...m.rects.map((r) => r.y + r.height)) - top
        return emit('decorationTap', { group, id: m.id, rect: { x: left + o.left, y: top + o.top, width, height } })
      }
    }
  }

  function applyStyle(s: Style) {
    const st = root.style
    if (s.fontSize !== undefined) st.fontSize = `${s.fontSize}px`
    if (s.lineHeight !== undefined) st.lineHeight = String(s.lineHeight)
    if (s.family !== undefined) st.fontFamily = s.family
    if (s.align !== undefined) st.textAlign = s.align
    if (s.theme) {
      st.backgroundColor = s.theme.bg
      st.color = s.theme.fg
      st.setProperty('--reader-link', s.theme.link ?? s.theme.fg)
    }
    if (s.insets) {
      st.paddingTop = `${s.insets.top}px`
      st.paddingBottom = `${s.insets.bottom}px`
    }
    if (s.fontFaceCss !== undefined) {
      fontFaces.textContent = s.fontFaceCss
      if (!fontFaces.isConnected) doc.head.append(fontFaces)
    }
  }

  function onScroll() {
    if (scroller.scrollTop === ownTop) return
    ownTop = null
    if (scrollQueued) return
    scrollQueued = true
    schedule(() => {
      scrollQueued = false
      if (!opened || target || styleAnchor) return
      last = capture()
      emit('relocated', { locator: last, reason: 'scroll' })
    })
  }

  function onResize() {
    if (!opened) return
    const h = measure(content).height
    if (h === height) return
    height = h
    paint()
    if (target || styleAnchor) return
    emit('relocated', { locator: last && land(last) ? last : capture(), reason: 'reflow' })
  }

  const scrollSource: EventTarget = scroller === page ? doc : scroller
  scrollSource.addEventListener('scroll', onScroll)
  root.addEventListener('click', onClick)
  const unobserve = observeResize(content, onResize)

  return {
    async open(d: ChapterDoc, at?: Locator, opId?: string) {
      if (d.layout !== 'reflow') throw new Error('reader-engine: the fixed layout arrives in Phase 5')
      const seq = ++moveSeq
      const mine = ++docSeq
      opened = true
      href = d.href
      content.innerHTML = d.html ?? ''
      content.lang = d.lang ?? ''
      content.dir = d.dir ?? ''
      text = chapterText(content)
      segments = segmentsOf(content)
      resolveMarks()
      layer.replaceChildren()
      const ours = at && at.href === href ? at : null
      target = ours ?? { href, type: 'text/html', locations: { progression: 0 } }
      styleAnchor = null
      last = null
      scrollTo(0)
      await fontsReady()
      await frame()
      if (mine !== docSeq) return superseded('open', opId)
      paint()
      emit('ready', { opId: opId ?? '', href })   // even when a goTo overtook the open: same document
      if (seq !== moveSeq) return superseded('open', opId)
      if (at && !ours) miss(at)
      return settle('open', opId, land(ours)!)
    },

    async goTo(at: Locator, o?: { align?: 'reading-line' | 'center'; opId?: string }) {
      const opId = o?.opId
      if (at.href !== href) {
        // D1: always a host bug; a silent jump would hide it (ADR-015). Not landed.
        miss(at)
        emit('relocated', { locator: here(), reason: 'goTo', opId })
        return 'superseded'
      }
      const seq = ++moveSeq
      target = at
      styleAnchor = null
      await frame()
      if (seq !== moveSeq) return superseded('goTo', opId)
      return settle('goTo', opId, land(at, o?.align === 'center' ? 0.5 : READING_LINE)!)
    },

    setStyle(s: Style, opId?: string) {
      const anchor = here()
      applyStyle(s)
      if (!target) styleAnchor = anchor
      const mine = ++styleSeq
      schedule(() => {
        if (!alive) return
        paint()
        if (mine === styleSeq && styleAnchor && !target) {
          const anchor = styleAnchor
          styleAnchor = null
          if (land(anchor)) return emit('relocated', { locator: last!, reason: 'style', opId })
        }
        emit('relocated', { locator: here(), reason: 'style', opId })
      })
    },

    current: () => (opened ? here() : null),

    decorate(group, items) {
      decorations[group] = items
      if (opened) redraw()
    },

    markWords(items, show) {
      words = items
      showTranslations = show
      if (opened) redraw()
    },

    find(query) {
      return findTextOffsets(text, query).map((at) => {
        const end = at + query.length
        const from = Math.max(0, at - FIND_CONTEXT)
        const to = Math.min(text.length, end + FIND_CONTEXT)
        const context = `${from > 0 ? '...' : ''}${text.slice(from, to)}${to < text.length ? '...' : ''}`
        return { locator: quoteAt(text, at, end, href), context }
      })
    },

    on(e, cb) {
      if (!listeners.has(e)) listeners.set(e, new Set())
      const set = listeners.get(e)!
      set.add(cb as (p: never) => void)
      return () => { set.delete(cb as (p: never) => void) }
    },

    destroy() {
      alive = false
      moveSeq++
      docSeq++
      opened = false
      target = styleAnchor = null
      listeners.clear()
      scrollSource.removeEventListener('scroll', onScroll)
      root.removeEventListener('click', onClick)
      unobserve()
      fontFaces.remove()
      root.replaceChildren()
      root.style.position = rootPosition
    },
  }
}
