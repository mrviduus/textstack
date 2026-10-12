// Test kit for engine.test.ts: a readable chapter, a fake layout (jsdom has none) and a reader driver,
// so each test reads as its rule (docs/05-features/reader-engine.md) and not as plumbing.
import { expect } from 'vitest'
import type { EngineEvents, Locator, Style } from './api'
import { createEngine } from './engine'
import { chapterText, locatorAt } from './text'

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
  return { boxes, total: y }
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
export function makeReader(opts: { html?: string; fonts?: () => Promise<void> } = {}) {
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

  let resize = () => {}
  const engine = createEngine(root, {
    scroller,
    measure: (el) => layout(root).boxes.get(el) ?? { top: 0, height: layout(root).total },
    viewport: () => ({ height: VIEWPORT }),
    schedule: (cb) => { setTimeout(cb, 0) },
    observeResize: (_el, cb) => { resize = cb; return () => { resize = () => {} } },
    fontsReady: opts.fonts ?? (() => Promise.resolve()),
  })
  engines.push(engine)

  const log: { event: keyof EngineEvents; payload: unknown }[] = []
  for (const event of ['ready', 'relocated', 'error'] as const) engine.on(event, (payload) => log.push({ event, payload }))
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
