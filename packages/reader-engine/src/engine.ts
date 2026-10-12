// Engine core, reflow (ADR-025): renders a chapter into the host's container, keeps the reader's place
// in the text across ops, style changes and late layout, and says why the place changed.
//
// - Every open / goTo / setStyle emits exactly one `relocated` with its opId before it resolves; a
//   newer open / goTo makes an older one resolve 'superseded' (ADR-019 rule 3: land on the ack).
// - Only user input after the last op settled is `reason: 'scroll'` (rule 7). Our own scroll's echo
//   is recognised by its scrollTop, not by a pixel tolerance.
// - While an op or a re-anchor is in flight, the place is its target, never the half-moved view
//   (rule 8): `current()`, a style change and a reflow all use it.
import type { ChapterDoc, EngineEvents, EngineOptions, GoToResult, Locator, Reason, ReaderEngine, Style } from './api'
import { resolveLocator, type Resolved } from './resolve'
import { chapterText, locatorAt, textNodes } from './text'

/** A quarter down the viewport: where both apps capture, so a position means the same place on each. */
const READING_LINE = 0.25

/** Inline elements share their block's box; a text node is placed by its nearest non-inline ancestor. */
const INLINE = new Set('A ABBR B BDI BDO BR CITE CODE DATA DEL DFN EM FONT I IMG INS KBD MARK Q S SAMP SMALL SPAN STRONG SUB SUP TIME TT U VAR'.split(' '))

/** A run of the chapter's text inside one block, with the chapter offset it starts at. */
interface Segment { el: Element; start: number; length: number }

/** Decorations, selection, footer and find arrive in slices 4 and 6. */
export type EngineCore = Pick<ReaderEngine, 'open' | 'goTo' | 'setStyle' | 'current' | 'on' | 'destroy'>

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
  const frame = () => new Promise<void>((r) => schedule(r))

  const content = doc.createElement('div')
  root.replaceChildren(content)
  const fontFaces = doc.createElement('style')

  let alive = true
  let opened = false
  let href: string | undefined
  let text = ''
  let segments: Segment[] = []
  let moveSeq = 0                        // open / goTo: a newer one supersedes an older
  let styleSeq = 0
  let target: Locator | null = null      // where the open / goTo in flight will land
  let styleAnchor: Locator | null = null // where the setStyle in flight will re-anchor
  let last: Locator | null = null        // the place a reflow keeps
  let ownTop: number | null = null       // the scrollTop we set; its scroll event is not reading
  let height = -1
  let scrollQueued = false
  const listeners = new Map<keyof EngineEvents, Set<(p: never) => void>>()

  function emit<K extends keyof EngineEvents>(e: K, p: EngineEvents[K]) {
    for (const cb of [...(listeners.get(e) ?? [])]) (cb as (p: EngineEvents[K]) => void)(p)
  }

  function segmentsOf(el: Element): Segment[] {
    const out: Segment[] = []
    let at = 0
    for (const t of textNodes(el)) {
      let block = t.parentElement!
      while (block !== el && INLINE.has(block.tagName)) block = block.parentElement!
      const prev = out[out.length - 1]
      if (prev?.el === block) prev.length += t.length
      else out.push({ el: block, start: at, length: t.length })
      at += t.length
    }
    // ponytail: a block with text both before and after a child block is two segments measured with
    // the parent's whole box, so the reading line there is approximate; per-line rects if it matters.
    return out
  }

  /** The chapter offset at content y. Linear in the block's height: the same map both ways. */
  function offsetAtY(y: number): number {
    const box = measure(content)
    y = Math.max(box.top, Math.min(y, box.top + box.height - 1))
    let above: Segment | undefined
    for (const s of segments) {
      const m = measure(s.el)
      if (m.top <= y && y < m.top + m.height) {
        return s.start + Math.min(s.length - 1, Math.floor(((y - m.top) / m.height) * s.length + 1e-6))
      }
      if (m.top + m.height <= y) above = s
    }
    // ponytail: linear scan of every block per capture; binary search on block tops if long chapters stutter.
    return above ? above.start + above.length : 0
  }

  function yAtOffset(offset: number): number {
    let seg = segments[segments.length - 1]
    for (const s of segments) if (s.start <= offset && offset < s.start + s.length) seg = s
    if (!seg) return 0
    const m = measure(seg.el)
    return m.top + (Math.min(offset - seg.start, seg.length) / seg.length) * m.height
  }

  /** The reader's place right now, read off the reading line. */
  function capture(): Locator {
    const vh = viewport().height
    const max = scroller.scrollHeight - vh
    const progression = max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0
    const at = offsetAtY(scroller.scrollTop + READING_LINE * vh)
    return (href && locatorAt(text, at, href, progression)) || { href, type: 'text/html', locations: { progression } }
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

  /** The op landed: one relocated, and this is now the place a reflow keeps. */
  function settle(reason: Reason, opId: string | undefined, result: GoToResult): GoToResult {
    target = null
    last = capture()
    height = measure(content).height
    emit('relocated', { locator: last, reason, opId })
    return result
  }

  function superseded(reason: Reason, opId: string | undefined): GoToResult {
    emit('relocated', { locator: here(), reason, opId })
    return 'superseded'
  }

  function miss(loc: Locator) {
    emit('error', { code: 'anchor-miss', detail: `locator is for chapter ${loc.href ?? '(none)'}, open is ${href ?? '(none)'}` })
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
    if (!opened || target || styleAnchor) return
    const h = measure(content).height
    if (h === height) return
    height = h
    const r = last && resolveLocator(last, href, text)
    if (r) scrollTo(topFor(r, READING_LINE))
    emit('relocated', { locator: capture(), reason: 'reflow' })
  }

  const scrollSource: EventTarget = scroller === page ? doc : scroller
  scrollSource.addEventListener('scroll', onScroll)
  const unobserve = observeResize(content, onResize)

  return {
    async open(d: ChapterDoc, at?: Locator, opId?: string) {
      if (d.layout !== 'reflow') throw new Error('reader-engine: the fixed layout arrives in Phase 5')
      const seq = ++moveSeq
      opened = true
      href = d.href
      content.innerHTML = d.html ?? ''
      content.lang = d.lang ?? ''
      content.dir = d.dir ?? ''
      text = chapterText(content)
      segments = segmentsOf(content)
      const ours = at && at.href === href ? at : null
      target = ours ?? { href, type: 'text/html', locations: { progression: 0 } }
      styleAnchor = null
      last = null
      scrollTo(0)
      await fontsReady()
      await frame()
      if (seq !== moveSeq) return superseded('open', opId)
      emit('ready', { opId: opId ?? '', href })
      if (seq !== moveSeq) return superseded('open', opId)   // a ready listener moved on
      if (at && !ours) miss(at)
      const r = resolveLocator(ours, href, text)!
      scrollTo(topFor(r, READING_LINE))
      return settle('open', opId, r.result)
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
      const r = resolveLocator(at, href, text)!
      scrollTo(topFor(r, o?.align === 'center' ? 0.5 : READING_LINE))
      return settle('goTo', opId, r.result)
    },

    setStyle(s: Style, opId?: string) {
      const anchor = here()
      applyStyle(s)
      if (!target) styleAnchor = anchor
      const mine = ++styleSeq
      schedule(() => {
        if (!alive) return
        if (mine === styleSeq && styleAnchor && !target) {
          const r = resolveLocator(styleAnchor, href, text)
          styleAnchor = null
          if (r) scrollTo(topFor(r, READING_LINE))
          last = capture()
          height = measure(content).height
        }
        emit('relocated', { locator: here(), reason: 'style', opId })
      })
    },

    current: () => (opened ? here() : null),

    on(e, cb) {
      if (!listeners.has(e)) listeners.set(e, new Set())
      const set = listeners.get(e)!
      set.add(cb as (p: never) => void)
      return () => { set.delete(cb as (p: never) => void) }
    },

    destroy() {
      alive = false
      moveSeq++
      opened = false
      target = styleAnchor = null
      listeners.clear()
      scrollSource.removeEventListener('scroll', onScroll)
      unobserve()
      fontFaces.remove()
      root.replaceChildren()
    },
  }
}
