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
// - What the reader does with the page becomes one event each (selection, hold, tap, link, image,
//   scroll direction, chapter end); the host draws every popup. Timings are the mobile bridge's.
import type { ChapterDoc, EngineEvents, EngineOptions, GoToResult, Locator, Reason, ReaderEngine, Rect, Style } from './api'
import { Overlayer, type DrawFn } from './overlay'
import { resolveLocator, type Resolved } from './resolve'
import { findTextOffsets } from './textWalker'
import { tokenizeVocabWords } from '../../shared/src/text/vocabKey'
import { locatorAt, matchWords, offsetOf, quoteAt, rangesIn, textNodes } from './text'

/** A quarter down the viewport: where both apps capture, so a position means the same place on each. */
const READING_LINE = 0.25

/** Inline elements share their block's box; a text node is placed by its nearest non-inline ancestor. */
const INLINE = new Set('A ABBR B BDI BDO BR CITE CODE DATA DEL DFN EM FONT I IMG INS KBD MARK Q S SAMP SMALL SPAN STRONG SUB SUP TIME TT U VAR'.split(' '))

/** ADR-019 rule 6: a webfont that never loads (captive portal) holds an open this long at most. */
const FONTS_DEADLINE_MS = 4000

/** Characters of text either side of a `find` match, like the web drawer's list. */
const FIND_CONTEXT = 40

/** iOS fires `selectionchange` all through a drag: a selection is sent once it stops changing. */
const SELECTION_SETTLE_MS = 220
/** A deliberate hold, not a brush; moving this far makes it a scroll. */
const HOLD_MS = 450
const HOLD_SLOP_PX = 8
/** The server's translate and TTS cap: a longer selection is still sent, flagged. */
const SELECTION_MAX_CHARS = 500
/** Hide the bars late, show them early. */
const SCROLL_DOWN_PX = 48
const SCROLL_UP_PX = 6
const SENTENCE_END = /[.!?\n]/
/** A longer sentence is cut to this many characters around the selection. */
const SENTENCE_MAX = 200

/** A run of the chapter's text inside one block, with the chapter offset it starts at. */
interface Segment { el: Element; start: number; length: number }

/** A decoration resolved in the open chapter. Words are drawn but not tapped (ADR-025: hold selects them). */
interface Mark { group: 'highlight' | 'search' | 'word' | 'selection'; id: string; start: number; end: number; color?: string; translation?: string; rects: Rect[] }
type Group = 'highlight' | 'search'
type DecorationItem = Parameters<ReaderEngine['decorate']>[1][number]
type WordItem = Parameters<ReaderEngine['markWords']>[0][number]

const COLORS = {
  highlight: 'var(--reader-highlight, rgba(254, 240, 138, 0.5))',
  search: 'var(--reader-search, rgba(250, 204, 21, 0.35))',
  word: 'var(--reader-word, rgba(59, 130, 246, 0.5))',
  selection: 'var(--reader-selection, rgba(196, 112, 75, 0.35))',
}
const DRAW: Record<Mark['group'], DrawFn> = { highlight: Overlayer.highlight, search: Overlayer.highlight, word: Overlayer.underline, selection: Overlayer.highlight }
const SVG = 'http://www.w3.org/2000/svg'

export function createEngine(root: HTMLElement, opts: EngineOptions = {}): ReaderEngine {
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
  const caretAt = opts.caret ?? ((x: number, y: number) => {
    const p = doc.caretPositionFromPoint?.(x, y)
    if (p) return { node: p.offsetNode, offset: p.offset }
    const r = doc.caretRangeFromPoint?.(x, y)
    return r ? { node: r.startContainer, offset: r.startOffset } : null
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
  // The open chapter's text nodes, walked once per open: the engine never changes them.
  let rangeOf: ReturnType<typeof rangesIn> = () => null
  let starts = new Map<Node, number>()
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
  let held: { start: number; end: number } | null = null   // the held word, marked until clearSelection
  let sent: { start: number; end: number; source: 'hold' | 'drag' } | null = null   // the selection the host has
  let selTimer = 0
  let holdTimer = 0
  let down: { x: number; y: number } | null = null         // a finger that may become a hold
  let swallowClick = false                                 // the click that ends a hold is not a tap
  let dir: 'up' | 'down' | null = null
  let dirBase = 0                                          // scrollTop where the last direction was decided
  let footer: HTMLElement | null = null
  let endSeen = false
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

  /**
   * The chapter offset at content y, estimated: linear in the block's height, the same map both ways.
   * Only where the browser has no caret or no box (jsdom); a real browser uses `probe` and line rects.
   */
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
    if (!hit) return above ? above.start + above.length : 0
    const { s, m } = hit
    return s.start + Math.min(s.length - 1, Math.floor(((y - m.top) / m.height) * s.length + 1e-6))
  }

  /**
   * The chapter offset under the reading line, by the browser's caret, the way both apps read it (web
   * `readReadingLine`): clamped into the chapter, a few x's in case one is a margin or an image. Null:
   * no caret API (jsdom) or no text there.
   */
  function probe(): number | null {
    const box = content.getBoundingClientRect()
    const line = (scroller === page ? 0 : scroller.getBoundingClientRect().top) + READING_LINE * viewport().height
    const y = Math.max(box.top + 4, Math.min(line, box.bottom - 4))
    for (const x of [box.left + 24, box.left + box.width / 2, box.right - 24]) {
      const c = caretAt(x, y)
      if (!c) continue
      const start = starts.get(c.node)
      const at = start !== undefined ? start + c.offset : content.contains(c.node) ? offsetOf(content, c.node, c.offset) : null
      if (at !== null) return at
    }
    return null
  }

  /** Content y of a chapter offset: the middle of its line, or the estimate where it has no box. */
  function yAtOffset(offset: number): number {
    const range = rangeOf(offset, 1)
    const r = range && rectsOf(range)[0]
    if (r) return measure(root).top + r.y + r.height / 2
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
    const at = probe() ?? offsetAtY(scroller.scrollTop + READING_LINE * viewport().height)
    return (href && locatorAt(text, at, href, progression())) || { href, type: 'text/html', locations: { progression: progression() } }
  }

  /**
   * Rule 8: the target in flight, else the last place reported (a landed op keeps its exact place until
   * the reader scrolls: the line holds many characters), else the reading line.
   */
  const here = () => target ?? styleAnchor ?? last ?? capture()

  function scrollTo(y: number) {
    scroller.scrollTop = Math.max(0, y)
    dirBase = ownTop = scroller.scrollTop
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
    checkEnd()
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
    if (held) marks.push({ group: 'selection', id: 'selection', ...held, rects: [] })
  }

  /** Draws every mark where its text is now. */
  function paint() {
    layer.replaceChildren()
    if (!marks.length) return
    const scratch = doc.createRange()   // marks keep rects, not ranges
    for (const m of marks) {
      const range = rangeOf(m.start, m.end - m.start, scratch)
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

  /** Root-relative line boxes as one box on screen. */
  function onScreen(rects: Rect[]): Rect {
    const o = root.getBoundingClientRect()
    if (!rects.length) return { x: o.left, y: o.top, width: 0, height: 0 }
    const left = Math.min(...rects.map((r) => r.x))
    const top = Math.min(...rects.map((r) => r.y))
    const width = Math.max(...rects.map((r) => r.x + r.width)) - left
    const height = Math.max(...rects.map((r) => r.y + r.height)) - top
    return { x: left + o.left, y: top + o.top, width, height }
  }

  /** The sentence around [start, end) inside its block, cut to SENTENCE_MAX around the selection. */
  function sentenceAt(start: number, end: number): string {
    const seg = segments.find((s) => start < s.start + s.length)
    const from = seg?.start ?? 0
    const to = seg ? seg.start + seg.length : text.length
    let a = start
    while (a > from && !SENTENCE_END.test(text[a - 1])) a--
    let b = end
    while (b < to && !SENTENCE_END.test(text[b - 1])) b++
    const sentence = text.slice(a, b).trim()
    if (sentence.length <= SENTENCE_MAX) return sentence
    const c = Math.max(a, start - 80, end - SENTENCE_MAX)
    const d = Math.min(b, c + SENTENCE_MAX)
    return `${c > a ? '...' : ''}${text.slice(c, d).trim()}${d < b ? '...' : ''}`
  }

  /** Sends [start, end) of the chapter text as a `selection`, without its edge whitespace, unless the host has it. */
  function select(start: number, end: number, source: 'hold' | 'drag') {
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    // The same text again (iOS re-fires; the platform's own long-press of a held word): the host has it.
    if (start === end || (sent && sent.start === start && sent.end === end)) return
    sent = { start, end, source }
    held = source === 'hold' ? { start, end } : null
    redraw()
    const range = rangeOf(start, end - start)
    emit('selection', {
      locator: quoteAt(text, start, end, href),
      text: text.slice(start, end),
      sentence: sentenceAt(start, end),
      source,
      tooLong: end - start > SELECTION_MAX_CHARS,
      rect: onScreen(range ? rectsOf(range) : []),
    })
  }

  /** The host's selection is gone: tell it. */
  function unselect() {
    if (!sent) return
    sent = held = null
    redraw()
    emit('selection', null)
  }

  function onSelectionChange() {
    win.clearTimeout(selTimer)
    selTimer = win.setTimeout(() => {
      if (!opened) return
      const sel = doc.getSelection()
      const r = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null
      // The part in the chapter: a drag may run on into the footer.
      const inner = doc.createRange()
      inner.selectNodeContents(content)
      if (r && r.compareBoundaryPoints(Range.START_TO_START, inner) > 0) inner.setStart(r.startContainer, r.startOffset)
      if (r && r.compareBoundaryPoints(Range.END_TO_END, inner) < 0) inner.setEnd(r.endContainer, r.endOffset)
      const start = r && !inner.collapsed ? offsetOf(content, inner.startContainer, inner.startOffset) : null
      const end = r && !inner.collapsed ? offsetOf(content, inner.endContainer, inner.endOffset) : null
      if (start !== null && end !== null) return select(start, end, 'drag')
      // A hold never makes a page selection: a collapse after one is the platform's noise (Android's menu).
      if (sent?.source === 'drag') unselect()
    }, SELECTION_SETTLE_MS)
  }

  /**
   * The word under a point on screen, as chapter offsets; null off the text or on no letter. Words are
   * the vocabulary's, plus the soft hyphens extraction puts inside long English words.
   */
  function wordAt(x: number, y: number): { start: number; end: number } | null {
    const c = caretAt(x, y)
    if (!c || c.node.nodeType !== Node.TEXT_NODE) return null
    const data = (c.node as Text).data
    const w = tokenizeVocabWords(data.replace(/\u00AD/g, 'a')).find((t) => t.start <= c.offset && c.offset <= t.end)
    const at = w && /\p{L}/u.test(w.word) ? offsetOf(content, c.node, w.start) : null
    return at != null ? { start: at, end: at + w!.end - w!.start } : null
  }

  function cancelHold() {
    win.clearTimeout(holdTimer)
    down = null
  }

  function onPointerDown(e: PointerEvent) {
    cancelHold()
    swallowClick = false
    // A mouse drags to select; a link owns its press.
    if (e.pointerType === 'mouse' || !content.contains(e.target as Node) || (e.target as Element).closest('a')) return
    const at = { x: e.clientX, y: e.clientY }
    down = at
    holdTimer = win.setTimeout(() => {
      down = null
      const word = wordAt(at.x, at.y)
      if (!word) return
      swallowClick = true
      emit('hold', at)   // first: the host's haptic
      // Drawn, never put in the page's selection: Android would open its own menu over the host's.
      select(word.start, word.end, 'hold')
    }, HOLD_MS)
  }

  function onPointerMove(e: PointerEvent) {
    if (down && (Math.abs(e.clientX - down.x) > HOLD_SLOP_PX || Math.abs(e.clientY - down.y) > HOLD_SLOP_PX)) cancelHold()
  }

  /** One event per tap: a link, an image, a highlight or search hit (highlights on top), else a plain tap. */
  function onClick(e: MouseEvent) {
    const t = e.target as Element
    if (swallowClick) { swallowClick = false; return }
    if (footer?.contains(t)) return                             // the host's buttons own their taps
    if (doc.getSelection()?.isCollapsed === false) return       // the end of a drag selection, not a tap
    const link = t.closest('a[href]')
    if (link && content.contains(link)) {
      e.preventDefault()
      const h = link.getAttribute('href')!
      return emit('linkClick', { href: h, internal: !/^([a-z][a-z\d+.-]*:|\/\/)/i.test(h) })
    }
    const img = t.closest('img')
    if (img && content.contains(img)) {
      const r = img.getBoundingClientRect()
      return emit('imageTap', { src: img.src, alt: img.alt || undefined, rect: { x: r.left, y: r.top, width: r.width, height: r.height } })
    }
    const o = root.getBoundingClientRect()
    const x = e.clientX - o.left
    const y = e.clientY - o.top
    for (const group of ['highlight', 'search'] as const) {
      for (let i = marks.length - 1; i >= 0; i--) {
        const m = marks[i]
        if (m.group !== group || !m.rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue
        return emit('decorationTap', { group, id: m.id, rect: onScreen(m.rects) })
      }
    }
    emit('tap', { x: e.clientX, y: e.clientY })
  }

  /** Once per open: the footer came into view. */
  function checkEnd() {
    if (endSeen || !footer || !opened || target) return
    if (measure(footer).top < scroller.scrollTop + viewport().height) {
      endSeen = true
      emit('chapterEnd', { visible: true })
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
    const d = scroller.scrollTop - dirBase
    const next = d >= SCROLL_DOWN_PX ? 'down' : d <= -SCROLL_UP_PX ? 'up' : null
    if (next) {
      dirBase = scroller.scrollTop
      if (next !== dir) emit('scrollDir', (dir = next))
    }
    if (scrollQueued) return
    scrollQueued = true
    schedule(() => {
      scrollQueued = false
      if (!opened || target || styleAnchor) return
      last = capture()
      emit('relocated', { locator: last, reason: 'scroll' })
      checkEnd()
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
    checkEnd()
  }

  const scrollSource: EventTarget = scroller === page ? doc : scroller
  scrollSource.addEventListener('scroll', onScroll)
  root.addEventListener('click', onClick)
  doc.addEventListener('selectionchange', onSelectionChange)
  root.addEventListener('pointerdown', onPointerDown)
  content.addEventListener('pointermove', onPointerMove)
  content.addEventListener('pointerup', cancelHold)
  content.addEventListener('pointercancel', cancelHold)
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
      starts = new Map()
      text = ''
      for (const t of textNodes(content)) { starts.set(t, text.length); text += t.data }
      rangeOf = rangesIn(content)
      segments = segmentsOf(content)
      cancelHold()
      unselect()
      endSeen = false
      resolveMarks()
      layer.replaceChildren()
      const ours = at && at.href === href ? at : null
      target = ours ?? { href, type: 'text/html', locations: { progression: 0 } }
      styleAnchor = null
      last = null
      scrollTo(0)
      let timer = 0
      // A font that fails ends the wait like one that loads.
      await Promise.race([fontsReady().catch(() => {}), new Promise<void>((r) => { timer = win.setTimeout(r, FONTS_DEADLINE_MS) })])
      win.clearTimeout(timer)
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
          if (land(anchor)) {
            emit('relocated', { locator: last!, reason: 'style', opId })
            return checkEnd()
          }
        }
        emit('relocated', { locator: here(), reason: 'style', opId })
      })
    },

    current: () => (opened ? here() : null),

    setFooter(el) {
      footer?.remove()
      footer = el
      if (el) content.after(el)
      checkEnd()
    },

    clearSelection() {
      sent = held = null
      redraw()
      const sel = doc.getSelection()
      if (sel?.anchorNode && content.contains(sel.anchorNode)) sel.removeAllRanges()
    },

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
      root.removeEventListener('pointerdown', onPointerDown)
      doc.removeEventListener('selectionchange', onSelectionChange)
      win.clearTimeout(selTimer)
      cancelHold()
      footer = null
      unobserve()
      fontFaces.remove()
      root.replaceChildren()
      root.style.position = rootPosition
    },
  }
}
