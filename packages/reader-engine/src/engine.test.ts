// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import type { EngineEvents, Locator } from './api'
import { createEngine } from './engine'
import { chapterText, positionAt, rangeAt } from './text'

/**
 * Engine core, reflow (ADR-025 Phase 2, slice 3). jsdom has no layout, so the tests pass the seams:
 * a fake scroller and a fake line layout that depends on the font size. Rule ids (E1…) are in the
 * test names; ADR-019 rules 3, 7 and 8 are pinned here at the engine level.
 */

const WORDS = 'river stone lantern harbor meadow copper whisper orchard thunder velvet compass ember glacier willow'.split(' ')
const PARAGRAPHS = Array.from({ length: 40 }, (_, i) =>
  `Part ${i}: ` + Array.from({ length: 45 }, (_, j) => WORDS[(i * 7 + j * 3) % WORDS.length] + (j % 9 === 8 ? '.' : '')).join(' '))
const HTML = PARAGRAPHS.map((p) => `<p>${p}</p>`).join('')
const VIEWPORT = 400
const WIDTH = 640

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const flush = async () => { for (let i = 0; i < 6; i++) await tick() }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

let destroyers: (() => void)[] = []
afterEach(() => { destroyers.forEach((d) => d()); destroyers = [] })

/** A reader on a fake layout: lines of `fontSize * 1.5` px, `WIDTH / (fontSize / 2)` characters each. */
function setup(opts: { fontsReady?: () => Promise<void> } = {}) {
  const root = document.createElement('div')
  document.body.append(root)
  const scroller = document.createElement('div')
  const layout = () => {
    const fs = parseFloat(root.style.fontSize) || 16
    const perLine = Math.floor(WIDTH / (fs / 2))
    const boxes = new Map<Element, { top: number; height: number }>()
    let y = 0
    for (const p of Array.from(root.querySelectorAll('p'))) {
      const height = Math.ceil((p.textContent ?? '').length / perLine) * fs * 1.5 + Number(p.getAttribute('data-extra') ?? 0)
      boxes.set(p, { top: y, height })
      y += height + fs
    }
    return { boxes, total: y }
  }
  let top = 0
  Object.defineProperty(scroller, 'scrollHeight', { get: () => layout().total })
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      const next = Math.max(0, Math.min(v, layout().total - VIEWPORT))
      if (next === top) return
      top = next
      setTimeout(() => scroller.dispatchEvent(new Event('scroll')), 0)   // like a browser: async echo
    },
  })
  let resize = () => {}
  const engine = createEngine(root, {
    scroller,
    measure: (el) => layout().boxes.get(el) ?? { top: 0, height: layout().total },
    viewport: () => ({ height: VIEWPORT }),
    schedule: (cb) => { setTimeout(cb, 0) },
    observeResize: (_el, cb) => { resize = cb; return () => { resize = () => {} } },
    fontsReady: opts.fontsReady ?? (() => Promise.resolve()),
  })
  destroyers.push(() => engine.destroy())
  const events: { e: keyof EngineEvents; p: unknown }[] = []
  for (const e of ['ready', 'relocated', 'error'] as const) engine.on(e, (p) => events.push({ e, p }))
  const relocated = () => events.filter((x) => x.e === 'relocated').map((x) => x.p as EngineEvents['relocated'])
  const content = () => root.firstElementChild!
  /** A stored reading position at `offset`, quoted the way the apps quote it. */
  const at = (offset: number, href = 'c1'): Locator => {
    const chapter = document.createElement('div')
    chapter.innerHTML = HTML
    const r = rangeAt(chapter, offset, 1)!
    return { ...positionAt(chapter, r.startContainer, r.startOffset, 'c1', 0.5)!, href }
  }
  return { root, scroller, engine, events, relocated, content, at, resize: () => resize(), userScroll: (y: number) => { scroller.scrollTop = y } }
}

/** The chapter offset of the text at the reading line now. */
const lineOffset = (engine: { current(): Locator | null }) => engine.current()!.locations.charOffset

// Below the first quarter screen: offset 0 cannot sit on the reading line (scrollTop stops at 0).
const TARGETS = [517, 1900, 4321, 7777, 9100]

describe('open', () => {
  it('E1 emits ready, then exactly one relocated with its opId, before the promise resolves', async () => {
    const { engine, events } = setup()
    const result = await engine.open({ href: 'c1', layout: 'reflow', html: HTML }, undefined, 'op1')
    expect(result).toBe('start')
    expect(events.map((x) => x.e)).toEqual(['ready', 'relocated'])
    expect(events[0].p).toEqual({ opId: 'op1', href: 'c1' })
    expect(events[1].p).toMatchObject({ reason: 'open', opId: 'op1', locator: { href: 'c1', type: 'text/html' } })
    expect(engine.current()!.locations.progression).toBe(0)
  })

  it('E1 renders the chapter; its text is what the anchors count', async () => {
    const { engine, content } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML })
    expect(chapterText(content())).toBe(PARAGRAPHS.join(''))
  })

  it('E2 a stored position lands exact, on the reading line', async () => {
    for (const offset of TARGETS) {
      const { engine, at, relocated } = setup()
      await engine.open({ href: 'c1', layout: 'reflow', html: HTML })
      const result = await engine.open({ href: 'c1', layout: 'reflow', html: HTML }, at(offset), 'op2')
      expect(result).toBe('exact')
      expect(lineOffset(engine)).toBe(offset)
      expect(relocated().at(-1)).toMatchObject({ reason: 'open', opId: 'op2', locator: { locations: { charOffset: offset } } })
    }
  })

  it("E3 (D1) another chapter's locator: an anchor-miss error naming it, and the chapter opens at the top", async () => {
    const { engine, events, at, scroller } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML })
    const result = await engine.open({ href: 'c1', layout: 'reflow', html: HTML }, at(1900, 'c9'), 'op')
    expect(result).toBe('start')
    expect(scroller.scrollTop).toBe(0)
    expect(events.find((x) => x.e === 'error')?.p).toMatchObject({ code: 'anchor-miss', detail: expect.stringContaining('c9') })
  })
})

describe('goTo', () => {
  it('E2 lands each target on the reading line, one relocated per op with its opId', async () => {
    const { engine, at, relocated } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML })
    for (const offset of TARGETS) {
      const result = await engine.goTo(at(offset), { opId: `g${offset}` })
      expect(result).toBe('exact')
      expect(lineOffset(engine)).toBe(offset)
      expect(relocated().filter((r) => r.opId === `g${offset}`)).toHaveLength(1)
    }
  })

  it('E2 a fraction-only locator lands on that fraction of the chapter', async () => {
    const { engine, scroller } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML })
    expect(await engine.goTo({ href: 'c1', type: 'text/html', locations: { progression: 0.5 } })).toBe('fraction')
    expect(scroller.scrollTop).toBeCloseTo((scroller.scrollHeight - VIEWPORT) / 2)
  })

  it("E3 (D1) another chapter's locator: no move, an anchor-miss error naming it, its relocated, not landed", async () => {
    const { engine, at, events, scroller, relocated } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML })
    await engine.goTo(at(4321))
    const before = scroller.scrollTop
    const result = await engine.goTo(at(1900, 'c9'), { opId: 'wrong' })
    expect(result).toBe('superseded')
    expect(scroller.scrollTop).toBe(before)
    expect(events.find((x) => x.e === 'error')?.p).toMatchObject({ code: 'anchor-miss', detail: expect.stringContaining('c9') })
    expect(relocated().filter((r) => r.opId === 'wrong')).toHaveLength(1)
  })

  it('E4 a newer op supersedes an older one: the older resolves superseded, each emits one relocated', async () => {
    const { engine, at, relocated } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML })
    const first = engine.goTo(at(1900), { opId: 'a' })
    const second = engine.goTo(at(7777), { opId: 'b' })
    expect(await first).toBe('superseded')
    expect(await second).toBe('exact')
    expect(relocated().filter((r) => r.opId === 'a')).toHaveLength(1)
    expect(relocated().filter((r) => r.opId === 'b')).toHaveLength(1)
    expect(lineOffset(engine)).toBe(7777)
  })

  it('E4 a second open supersedes the first', async () => {
    const fonts = deferred()
    const { engine, at } = setup({ fontsReady: () => fonts.promise })
    const first = engine.open({ href: 'c1', layout: 'reflow', html: HTML }, undefined, 'o1')
    const second = engine.open({ href: 'c1', layout: 'reflow', html: HTML }, undefined, 'o2')
    fonts.resolve()
    expect(await first).toBe('superseded')
    expect(await second).toBe('start')
    expect(await engine.goTo(at(517))).toBe('exact')
  })
})

describe("'scroll' is reading; programmatic moves are not (ADR-019 rule 7)", () => {
  it('E5 the scroll echo of open / goTo / setStyle emits no scroll relocated', async () => {
    const { engine, at, relocated } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML }, at(1900))
    await engine.goTo(at(7777))
    engine.setStyle({ fontSize: 24 })
    await flush()
    expect(relocated().map((r) => r.reason)).toEqual(['open', 'goTo', 'style'])
  })

  it('E5 a user scroll after the ops settled is one scroll relocated, no opId, at the new reading line', async () => {
    const { engine, at, relocated, scroller, userScroll } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML }, at(1900))
    await flush()
    userScroll(scroller.scrollTop + 600)
    await flush()
    const last = relocated().at(-1)!
    expect(last.reason).toBe('scroll')
    expect(last.opId).toBeUndefined()
    expect(last.locator.locations.charOffset).toBeGreaterThan(1900)
    expect(relocated().filter((r) => r.reason === 'scroll')).toHaveLength(1)
  })

  it('E5 a user scroll while an op is in flight is not reading (rule 3: the op lands, then scroll counts)', async () => {
    const fonts = deferred()
    const { engine, at, relocated, userScroll } = setup({ fontsReady: () => fonts.promise })
    const opening = engine.open({ href: 'c1', layout: 'reflow', html: HTML }, undefined, 'o')
    userScroll(900)
    await flush()
    expect(relocated()).toEqual([])
    fonts.resolve()
    await opening
    await flush()
    expect(relocated().map((r) => r.reason)).toEqual(['open'])
    expect(await engine.goTo(at(517))).toBe('exact')
  })
})

describe('setStyle re-anchors on the text (ADR-019 rule 8)', () => {
  it('E6 a font change keeps the same text on the reading line, never rebuilds the document', async () => {
    const { engine, at, root, relocated, content, scroller } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML }, at(4321))
    const node = content().firstChild
    const before = scroller.scrollTop
    engine.setStyle({ fontSize: 24 }, 's1')
    await flush()
    expect(root.style.fontSize).toBe('24px')
    expect(scroller.scrollTop).not.toBe(before)
    expect(lineOffset(engine)).toBe(4321)
    expect(content().firstChild, 'same nodes').toBe(node)
    expect(relocated().filter((r) => r.opId === 's1')).toMatchObject([{ reason: 'style', locator: { locations: { charOffset: 4321 } } }])
  })

  it('E6 two quick font changes re-anchor on the first place, not on a half-reflowed view', async () => {
    const { engine, at, relocated } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML }, at(4321))
    engine.setStyle({ fontSize: 20 }, 's1')
    engine.setStyle({ fontSize: 28 }, 's2')
    await flush()
    expect(lineOffset(engine)).toBe(4321)
    expect(relocated().filter((r) => r.opId === 's1' || r.opId === 's2')).toHaveLength(2)
  })

  it('E7 a style change during an open keeps the pending target; the open still lands', async () => {
    let held: ReturnType<typeof deferred> | null = null
    const { engine, at, relocated } = setup({ fontsReady: () => held?.promise ?? Promise.resolve() })
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML })
    const target = at(7777)
    // Hold the restore on fonts, change the style mid-restore.
    held = deferred()
    const opening = engine.open({ href: 'c1', layout: 'reflow', html: HTML }, target, 'restore')
    engine.setStyle({ fontSize: 24 }, 'style')
    await flush()
    expect(engine.current()!.locations.charOffset, 'mid-restore current() is the target, not the half-restored view').toBe(7777)
    held.resolve()
    expect(await opening).toBe('exact')
    await flush()
    expect(lineOffset(engine)).toBe(7777)
    expect(relocated().find((r) => r.opId === 'style')!.locator.locations.charOffset).toBe(7777)
    expect(relocated().find((r) => r.opId === 'restore')!.locator.locations.charOffset).toBe(7777)
  })
})

describe('late layout (images, webfonts) re-anchors', () => {
  it('E8 content above grows: one reflow relocated, no opId, same text on the reading line', async () => {
    const { engine, at, root, relocated, resize } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML }, at(4321))
    await flush()
    root.querySelector('p')!.setAttribute('data-extra', '500')   // an image above the reader loaded
    resize()
    await flush()
    expect(lineOffset(engine)).toBe(4321)
    expect(relocated().at(-1)).toMatchObject({ reason: 'reflow' })
    expect(relocated().at(-1)!.opId).toBeUndefined()
    expect(relocated().filter((r) => r.reason === 'scroll')).toEqual([])
  })

  it('E8 a resize that changes nothing emits nothing', async () => {
    const { engine, at, relocated, resize } = setup()
    await engine.open({ href: 'c1', layout: 'reflow', html: HTML }, at(4321))
    const n = relocated().length
    resize()
    await flush()
    expect(relocated()).toHaveLength(n)
  })
})

describe('destroy', () => {
  it('E9 stops events and empties the root; an op in flight resolves superseded', async () => {
    const fonts = deferred()
    const { engine, root, events, userScroll } = setup({ fontsReady: () => fonts.promise })
    const opening = engine.open({ href: 'c1', layout: 'reflow', html: HTML })
    engine.destroy()
    fonts.resolve()
    expect(await opening).toBe('superseded')
    userScroll(500)
    await flush()
    expect(events).toEqual([])
    expect(root.childNodes).toHaveLength(0)
    expect(engine.current()).toBeNull()
  })
})
