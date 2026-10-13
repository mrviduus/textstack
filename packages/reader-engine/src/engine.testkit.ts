// Test kit for engine.test.ts: a readable chapter, a fake layout (jsdom has none) and a reader driver,
// so each test reads as its rule (docs/05-features/reader-engine.md) and not as plumbing.
import { expect } from 'vitest'
import type { EngineEvents, Locator, Rect, Style } from './api'
import { createEngine } from './engine'
import { chapterText, locatorAt, rangeAt, textNodes } from './text'

// --- The chapter: 30 paragraphs, every sentence unique, so a quote can only mean one place ---------

const PLACES = 'Arden Brill Corran Dunmore Elgin Fintra Galway Hollin Ilkley Jura Kells Lerwick Malin Nairn Oban Portree Quoyle Rosslare Sligo Tobermory Ullapool Valentia Wexford Youghal Zennor Ardmore Bantry Clifden Dingle Easky'.split(' ')

/** The last sentence of the chapter. */
export const LAST_SENTENCE = 'Easky log 4: the keeper counted 33 ships before dawn.'

export const PARAGRAPHS = PLACES.map((place, i) =>
  [1, 2, 3, 4].map((n) => `${place} log ${n}: the keeper counted ${i + n} ships before dawn.`).join(' '))

/** The chapter as the server sends it: one `<p>` per paragraph, nothing between them. */
export const CHAPTER = PARAGRAPHS.map((p) => `<p>${p}</p>`).join('')

/** Real server HTML: newlines between blocks, and every fifth paragraph quoted inside a blockquote. */
export const REAL_CHAPTER = PARAGRAPHS
  .map((p, i) => (i % 5 === 2 ? `<blockquote>Quoted: <p>${p}</p></blockquote>` : `<p>${p}</p>`))
  .join('\n')

// --- The fake layout -------------------------------------------------------------------------------

const VIEWPORT = 400
const WIDTH = 640

/** Lines of `fontSize * 1.5` px, `WIDTH / (fontSize / 2)` characters each, a `fontSize` gap after each `<p>`. */
function layout(root: HTMLElement) {
  const fs = parseFloat(root.style.fontSize) || 16
  const perLine = Math.floor(WIDTH / (fs / 2))
  const boxes = new Map<Element, { top: number; height: number }>()
  let y = 0
  for (const p of Array.from(root.querySelectorAll('p'))) {
    const height = Math.ceil((p.textContent ?? '').length / perLine) * fs * 1.5 + Number(p.getAttribute('data-grown') ?? 0)
    boxes.set(p, { top: y, height })
    y += height + fs
  }
  if (root.firstElementChild) boxes.set(root.firstElementChild, { top: 0, height: y })   // the chapter, without the footer
  const footer = root.querySelector('footer')   // the host's chapter-end block (setFooter)
  if (footer) { boxes.set(footer, { top: y, height: 100 }); y += 100 }
  return { boxes, total: y }
}

/** Characters of `p` that `range` covers, [start, end); null when none. */
function charsIn(p: Element, range: Range): [number, number] | null {
  let at = 0
  let start = -1
  let end = -1
  for (const t of textNodes(p)) {
    const from = t === range.startContainer ? range.startOffset : range.comparePoint(t, 0) >= 0 ? 0 : t.length
    const to = t === range.endContainer ? range.endOffset : range.comparePoint(t, t.length) <= 0 ? t.length : 0
    if (to > from) { if (start < 0) start = at + from; end = at + to }
    at += t.length
  }
  return start < 0 ? null : [start, end]
}

/** A range's line boxes on the fake layout, in the chapter's coordinates: one per line it covers. */
function lineBoxes(root: HTMLElement, range: Range): Rect[] {
  const fs = parseFloat(root.style.fontSize) || 16
  const perLine = Math.floor(WIDTH / (fs / 2))
  const { boxes } = layout(root)
  const out: Rect[] = []
  for (const p of Array.from(root.querySelectorAll('p'))) {
    const chars = range.intersectsNode(p) ? charsIn(p, range) : null
    if (!chars) continue
    for (let i = chars[0]; i < chars[1];) {
      const line = Math.floor(i / perLine)
      const stop = Math.min(chars[1], (line + 1) * perLine)
      out.push({ x: (i % perLine) * (fs / 2), y: boxes.get(p)!.top + line * fs * 1.5, width: (stop - i) * (fs / 2), height: fs * 1.5 })
      i = stop
    }
  }
  return out
}

// --- The reader driver ------------------------------------------------------------------------------

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

const engines: { destroy(): void }[] = []
/** Call from afterEach. */
export function destroyAll() { engines.splice(0).forEach((e) => e.destroy()) }

/**
 * A reader on the fake layout. `fonts` holds every open on a promise (a slow webfont), to catch the
 * engine mid-op.
 */
/** `noCaret`: a browser without `caretPositionFromPoint` or line boxes, so the engine estimates. */
export function makeReader(opts: { html?: string; fonts?: () => Promise<void>; noCaret?: boolean } = {}) {
  const html = opts.html ?? CHAPTER
  const root = document.createElement('div')
  document.body.append(root)

  const scroller = document.createElement('div')
  let top = 0
  Object.defineProperty(scroller, 'scrollHeight', { get: () => layout(root).total })
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      const next = Math.max(0, Math.min(v, layout(root).total - VIEWPORT))
      if (next === top) return
      top = next
      setTimeout(() => scroller.dispatchEvent(new Event('scroll')), 0)   // like a browser: the event comes later
    },
  })

  // The chapter's top-left on screen: it moves up as the reader scrolls.
  root.getBoundingClientRect = () => new DOMRect(0, -top, WIDTH, layout(root).total)

  /** The caret at a point on screen: the character under it on the fake layout. */
  function caret(x: number, y: number): { node: Node; offset: number } | null {
    const fs = parseFloat(root.style.fontSize) || 16
    const perLine = Math.floor(WIDTH / (fs / 2))
    const at = y + top
    for (const [p, box] of layout(root).boxes) {
      if (p.tagName !== 'P' || at < box.top || at >= box.top + box.height) continue
      let char = Math.floor((at - box.top) / (fs * 1.5)) * perLine + Math.floor(x / (fs / 2))
      for (const t of textNodes(p)) {
        if (char < t.length) return { node: t, offset: char }
        char -= t.length
      }
    }
    return null
  }

  let resize = () => {}
  const engine = createEngine(root, {
    scroller,
    measure: (el) => layout(root).boxes.get(el) ?? { top: 0, height: layout(root).total },
    viewport: () => ({ height: VIEWPORT }),
    schedule: (cb) => { setTimeout(cb, 0) },
    observeResize: (_el, cb) => { resize = cb; return () => { resize = () => {} } },
    fontsReady: opts.fonts ?? (() => Promise.resolve()),
    rects: (range) => (opts.noCaret ? [] : lineBoxes(root, range)),
    caret: opts.noCaret ? () => null : caret,
  })
  engines.push(engine)
  // The chapter fills the root: the engine probes the reading line inside its box.
  ;(root.firstElementChild as HTMLElement).getBoundingClientRect = () => root.getBoundingClientRect()

  const log: { event: keyof EngineEvents; payload: unknown }[] = []
  for (const event of ['ready', 'relocated', 'error', 'decorationTap', 'selection', 'hold', 'tap', 'imageTap', 'linkClick', 'scrollDir', 'chapterEnd'] as const) engine.on(event, (payload) => log.push({ event, payload }))
  const relocations = () => log.filter((x) => x.event === 'relocated').map((x) => x.payload as EngineEvents['relocated'])

  const text = (() => { const el = document.createElement('div'); el.innerHTML = html; return chapterText(el) })()

  return {
    engine,
    root,
    /** A stored reading position at the start of `sentence`, as the apps store one. */
    place(sentence: string, href = 'c1'): Locator {
      const at = text.indexOf(sentence)
      if (at < 0) throw new Error(`not in the chapter: ${sentence}`)
      return { ...locatorAt(text, at, 'c1', 0.5)!, href }
    },
    open(at?: string | Locator, opId?: string) {
      return engine.open({ href: 'c1', layout: 'reflow', html }, typeof at === 'string' ? this.place(at) : at, opId)
    },
    goTo(at: string | Locator, opId?: string) {
      return engine.goTo(typeof at === 'string' ? this.place(at) : at, { opId })
    },
    setStyle(s: Style, opId?: string) { engine.setStyle(s, opId) },
    /** The reader scrolls by hand. */
    scrollBy(px: number) { scroller.scrollTop = top + px },
    get scrollTop() { return top },
    get maxScroll() { return layout(root).total - VIEWPORT },
    /** An image in the paragraph holding `sentence` finished loading and grew it by `px`. */
    grow(sentence: string, px: number) {
      const p = Array.from(root.querySelectorAll('p')).find((el) => el.textContent?.includes(sentence))!
      p.setAttribute('data-grown', String(px))
      resize()
    },
    /** A highlight as the apps store one: the `nth` occurrence of `quote`, with 30 characters either side. */
    quote(quote: string, nth = 0, href = 'c1'): Locator {
      let at = -1
      for (let i = 0; i <= nth; i++) at = text.indexOf(quote, at + 1)
      if (at < 0) throw new Error(`not in the chapter: ${quote}`)
      const end = at + quote.length
      return { href, type: 'text/html', locations: { charOffset: at }, text: { before: text.slice(Math.max(0, at - 30), at), highlight: quote, after: text.slice(end, end + 30) } }
    },
    /** The chapter's own element (the engine draws decorations beside it, never in it). */
    get chapter(): HTMLElement { return root.firstElementChild as HTMLElement },
    /** The line boxes of the `nth` occurrence of `quote` in the chapter, where they are now. */
    boxesOf(quote: string, nth = 0): Rect[] {
      let at = -1
      for (let i = 0; i <= nth; i++) at = text.indexOf(quote, at + 1)
      if (at < 0) throw new Error(`not in the chapter: ${quote}`)
      return lineBoxes(root, rangeAt(this.chapter, at, quote.length)!)
    },
    /** What is drawn for a group: each item's id and its boxes, read off the overlay. */
    drawn(group: 'highlight' | 'search' | 'word' | 'selection'): { id: string; rects: Rect[] }[] {
      return Array.from(root.querySelectorAll(`[data-group="${group}"]`)).map((g) => ({
        id: g.getAttribute('data-id') ?? '',
        rects: Array.from(g.querySelectorAll('rect')).map((r) => ({
          x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')),
          width: Number(r.getAttribute('width')), height: Number(r.getAttribute('height')),
        })),
      }))
    },
    /** The inline translations drawn: text and position. */
    translations(): { text: string; x: number; y: number }[] {
      return Array.from(root.querySelectorAll('text')).map((t) => ({ text: t.textContent ?? '', x: Number(t.getAttribute('x')), y: Number(t.getAttribute('y')) }))
    },
    /** The reader taps at a point on screen (on `target`, the element under it, when it matters). False: the page's default was stopped. */
    tap(x: number, y: number, target: Element = root) {
      return target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
    },
    /** A point on screen over the first character of the `nth` occurrence of `quote`. */
    pointAt(quote: string, nth = 0): { x: number; y: number } {
      const b = this.boxesOf(quote, nth)[0]
      return { x: b.x + 1, y: b.y - top + 1 }
    },
    /** A finger goes down / moves / lifts at a point on screen. */
    pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number, target: Element = root.firstElementChild!) {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType: 'touch' }))
    },
    /** The reader drags a selection over the `nth` occurrence of `quote`, or over a range (null: taps it away). */
    select(quote: string | Range | null, nth = 0) {
      const sel = document.getSelection()!
      sel.removeAllRanges()
      if (quote instanceof Range) sel.addRange(quote)
      else if (quote !== null) {
        let at = -1
        for (let i = 0; i <= nth; i++) at = text.indexOf(quote, at + 1)
        sel.addRange(rangeAt(this.chapter, at, quote.length)!)
      }
      document.dispatchEvent(new Event('selectionchange'))
    },
    /** The host's chapter-end block. */
    footer(): HTMLElement {
      const el = document.createElement('footer')
      el.textContent = 'Next chapter'
      engine.setFooter(el)
      return el
    },
    /** A resize callback with nothing changed. */
    resizeNothing() { resize() },
    /** Let every pending frame, timer and scroll event run. */
    async settle() { for (let i = 0; i < 6; i++) await tick() },
    /** The text that starts on the reading line now. */
    line(): string { return engine.current()?.text?.highlight ?? '' },
    events: () => log.map((x) => x.event),
    payloads: (event: keyof EngineEvents) => log.filter((x) => x.event === event).map((x) => x.payload),
    relocations,
    /** The op's ack: asserts there is exactly one `relocated` with this opId, and returns it. */
    ack(opId: string): EngineEvents['relocated'] {
      const mine = relocations().filter((r) => r.opId === opId)
      expect(mine, `relocated events for ${opId}`).toHaveLength(1)
      return mine[0]
    },
    reasons: () => relocations().map((r) => r.reason),
  }
}
