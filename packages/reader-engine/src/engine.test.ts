// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { LAST_SENTENCE, PARAGRAPHS, REAL_CHAPTER, deferred, destroyAll, makeReader } from './engine.testkit'
import { chapterText } from './text'
import { createEngine } from './engine'

/**
 * Engine core, reflow. Each test name starts with its rule ID; the rules, in plain words, are in
 * docs/05-features/reader-engine.md. The fake layout and the reader driver are in engine.testkit.ts.
 */

afterEach(destroyAll)

const MIDDLE = 'Malin log 3'
const FURTHER = 'Valentia log 2'

describe('open', () => {
  it('E1 says ready, then acks the open once, before the promise resolves', async () => {
    const reader = makeReader()
    expect(await reader.open(undefined, 'open-1')).toBe('start')
    expect(reader.events()).toEqual(['ready', 'relocated'])
    expect(reader.payloads('ready')).toEqual([{ opId: 'open-1', href: 'c1' }])
    expect(reader.ack('open-1').reason).toBe('open')
  })

  it('E1 shows the chapter: its text is the text anchors count', async () => {
    const reader = makeReader()
    await reader.open()
    expect(chapterText(reader.root)).toBe(PARAGRAPHS.join(''))
  })

  it('E2 a saved position opens with that sentence on the reading line', async () => {
    const reader = makeReader()
    expect(await reader.open(MIDDLE)).toBe('exact')
    expect(reader.line()).toMatch(/^Malin log 3:/)
  })

  it("E3 another chapter's position: opens at the top, and says why", async () => {
    const reader = makeReader()
    expect(await reader.open(reader.place(MIDDLE, 'chapter-9'))).toBe('start')
    expect(reader.scrollTop).toBe(0)
    expect(reader.payloads('error')).toEqual([{ code: 'anchor-miss', detail: expect.stringContaining('chapter-9') }])
  })

  it('E4 a second open replaces the first: the first is superseded', async () => {
    const fonts = deferred()
    const reader = makeReader({ fonts: () => fonts.promise })
    const first = reader.open(undefined, 'first')
    const second = reader.open(undefined, 'second')
    fonts.resolve()
    expect(await first).toBe('superseded')
    expect(await second).toBe('start')
  })

  it('E12 a goTo that overtakes the open still gets the chapter its ready', async () => {
    const fonts = deferred()
    const reader = makeReader({ fonts: () => fonts.promise })
    const opening = reader.open(undefined, 'open-1')
    const going = reader.goTo(MIDDLE)
    fonts.resolve()
    expect(await opening).toBe('superseded')
    expect(await going).toBe('exact')
    expect(reader.payloads('ready')).toEqual([{ opId: 'open-1', href: 'c1' }])
  })

  it('E46 an open overtaken by a goTo resolves superseded, yet its document landed: current() is that chapter', async () => {
    const fonts = deferred()
    const reader = makeReader({ fonts: () => fonts.promise })
    const opening = reader.open()
    const going = reader.goTo(MIDDLE)
    fonts.resolve()
    expect(await opening).toBe('superseded')
    expect(reader.engine.current()?.href).toBe('c1')
    await going
    expect(reader.line()).toMatch(/^Malin log 3:/)
  })

  it('E46 an open replaced by destroy resolves superseded with nothing current', async () => {
    const fonts = deferred()
    const reader = makeReader({ fonts: () => fonts.promise })
    const opening = reader.open()
    reader.engine.destroy()
    fonts.resolve()
    expect(await opening).toBe('superseded')
    expect(reader.engine.current()).toBeNull()
  })
})

describe('goTo', () => {
  it('E2 puts the sentence on the reading line and acks once', async () => {
    const reader = makeReader()
    await reader.open()
    for (const sentence of ['Corran log 2', MIDDLE, FURTHER, 'Bantry log 1']) {
      expect(await reader.goTo(sentence, sentence)).toBe('exact')
      expect(reader.line().startsWith(sentence)).toBe(true)
      expect(reader.ack(sentence).reason).toBe('goTo')
    }
  })

  it('E2 a position with only a fraction lands on that fraction of the chapter', async () => {
    const reader = makeReader()
    await reader.open()
    expect(await reader.engine.goTo({ href: 'c1', type: 'text/html', locations: { progression: 0.5 } })).toBe('fraction')
    expect(reader.scrollTop).toBeCloseTo(reader.maxScroll / 2)
  })

  it("E2 a fraction is of the chapter itself, as the apps store it: the host's footer is not part of it", async () => {
    const reader = makeReader()
    reader.footer()   // 100 px on the fake layout
    await reader.open()
    await reader.engine.goTo({ href: 'c1', type: 'text/html', locations: { progression: 0.5 } })
    expect(reader.scrollTop).toBeCloseTo((reader.maxScroll - 100) / 2)
    expect(reader.engine.current()!.locations.progression).toBeCloseTo(0.5)
  })

  it("E3 another chapter's position: no move, an error naming it, not landed", async () => {
    const reader = makeReader()
    await reader.open(MIDDLE)
    const before = reader.scrollTop
    expect(await reader.goTo(reader.place(FURTHER, 'chapter-9'), 'wrong')).toBe('superseded')
    expect(reader.scrollTop).toBe(before)
    expect(reader.payloads('error')).toEqual([{ code: 'anchor-miss', detail: expect.stringContaining('chapter-9') }])
    reader.ack('wrong')
  })

  it('E4 a newer goTo supersedes an older one; each is acked once', async () => {
    const reader = makeReader()
    await reader.open()
    const older = reader.goTo(MIDDLE, 'older')
    const newer = reader.goTo(FURTHER, 'newer')
    expect(await older).toBe('superseded')
    expect(await newer).toBe('exact')
    reader.ack('older')
    reader.ack('newer')
    expect(reader.line().startsWith(FURTHER)).toBe(true)
  })

  it('E11 near the chapter end the scroll stops short; the ack still names the sentence asked for', async () => {
    const reader = makeReader()
    await reader.open(LAST_SENTENCE, 'to-the-end')
    expect(reader.scrollTop).toBe(reader.maxScroll)
    expect(reader.ack('to-the-end').locator.text?.highlight).toBe(LAST_SENTENCE)
  })
})

describe('scrolling: only the reader scrolling is reading (ADR-019 rule 7)', () => {
  it("E5 the engine's own scrolls are never 'scroll'", async () => {
    const reader = makeReader()
    await reader.open(MIDDLE)
    await reader.goTo(FURTHER)
    reader.setStyle({ fontSize: 24 })
    await reader.settle()
    expect(reader.reasons()).toEqual(['open', 'goTo', 'style'])
  })

  it("E5 the reader scrolling after the ops is one 'scroll', with no opId, further on", async () => {
    const reader = makeReader()
    await reader.open(MIDDLE, 'open')
    await reader.settle()
    reader.scrollBy(600)
    await reader.settle()
    expect(reader.reasons()).toEqual(['open', 'scroll'])
    const scroll = reader.relocations()[1]
    expect(scroll.opId).toBeUndefined()
    expect(scroll.locator.locations.charOffset!).toBeGreaterThan(reader.ack('open').locator.locations.charOffset!)
  })

  it('E25 with no caret API, the estimate still reads a scroll and lands it back', async () => {
    const reader = makeReader({ noCaret: true })
    await reader.open(MIDDLE, 'open')
    reader.scrollBy(600)
    await reader.settle()
    const read = reader.engine.current()!
    expect(read.locations.charOffset!).toBeGreaterThan(reader.ack('open').locator.locations.charOffset!)
    const top = reader.scrollTop
    await reader.goTo(FURTHER)
    await reader.goTo(read)
    expect(Math.abs(reader.scrollTop - top)).toBeLessThan(1)   // the estimate is per character
  })

  /** A text node inside `host`, as the caret would hit it. */
  const textIn = (host: HTMLElement) => {
    host.textContent = 'Translate Explain'
    document.body.append(host)
    return () => ({ node: host.firstChild!, offset: 0 })
  }

  it('E45 a popup over the reading line is a cover: the scroll is read from the line boxes', async () => {
    const reader = makeReader({ caret: textIn(document.createElement('div')) })
    await reader.open(MIDDLE)
    const before = reader.boxReads()
    reader.scrollBy(600)
    await reader.settle()
    expect(reader.boxReads()).toBeGreaterThan(before)
  })

  it("E45 another engine's chapter under the caret (web's next chapter) is no cover: no line-box search", async () => {
    const other = makeReader()   // its root carries the engine's mark
    const reader = makeReader({ caret: () => ({ node: other.chapter.querySelector('p')!.firstChild!, offset: 0 }) })
    await other.open()
    await reader.open(MIDDLE)
    const before = reader.boxReads()
    reader.scrollBy(600)
    await reader.settle()
    expect(reader.boxReads()).toBe(before)
  })

  it('E26 current() follows a scroll the engine has not read yet (the app went to the background)', async () => {
    const reader = makeReader()
    await reader.open(MIDDLE)
    await reader.settle()
    reader.scrollBy(600)   // no scroll event, no frame yet: both stop in a hidden page
    expect(reader.line().startsWith(MIDDLE)).toBe(false)
  })

  it('E5 scrolling while an open is still running is not reading', async () => {
    const fonts = deferred()
    const reader = makeReader({ fonts: () => fonts.promise })
    const opening = reader.open()
    reader.scrollBy(900)
    await reader.settle()
    expect(reader.relocations()).toEqual([])
    fonts.resolve()
    await opening
    await reader.settle()
    expect(reader.reasons()).toEqual(['open'])
  })
})

describe('style changes keep the place (ADR-019 rule 8)', () => {
  it('E6 a bigger font keeps the same sentence on the reading line, without rebuilding the chapter', async () => {
    const reader = makeReader()
    await reader.open(FURTHER)
    const firstParagraph = reader.root.querySelector('p')
    reader.setStyle({ fontSize: 24 }, 'bigger')
    await reader.settle()
    expect(reader.root.style.fontSize).toBe('24px')
    expect(reader.line().startsWith(FURTHER)).toBe(true)
    expect(reader.ack('bigger').reason).toBe('style')
    expect(reader.root.querySelector('p'), 'same nodes').toBe(firstParagraph)
  })

  it('E6 two quick font changes still keep the first place', async () => {
    const reader = makeReader()
    await reader.open(FURTHER)
    reader.setStyle({ fontSize: 20 }, 'a')
    reader.setStyle({ fontSize: 28 }, 'b')
    await reader.settle()
    expect(reader.line().startsWith(FURTHER)).toBe(true)
    reader.ack('a')
    reader.ack('b')
  })

  it('E7 a font change in the middle of a restore keeps the restore target', async () => {
    let fonts: Promise<void> = Promise.resolve()
    const reader = makeReader({ fonts: () => fonts })
    await reader.open()
    const slowFont = deferred()
    fonts = slowFont.promise
    const restoring = reader.open(FURTHER, 'restore')
    reader.setStyle({ fontSize: 24 }, 'bigger')
    await reader.settle()
    expect(reader.line(), 'mid-restore, the place is the target').toMatch(/^Valentia log 2:/)
    slowFont.resolve()
    expect(await restoring).toBe('exact')
    expect(reader.line().startsWith(FURTHER)).toBe(true)
    expect(reader.ack('bigger').locator.text?.highlight).toMatch(/^Valentia log 2:/)
    expect(reader.ack('restore').locator.text?.highlight).toMatch(/^Valentia log 2:/)
  })
})

describe('late layout keeps the place', () => {
  it('E8 an image above the reader loads: the same sentence stays on the line, one reflow, no opId', async () => {
    const reader = makeReader()
    await reader.open(FURTHER)
    await reader.settle()
    reader.grow('Arden log 1', 500)
    await reader.settle()
    expect(reader.line().startsWith(FURTHER)).toBe(true)
    expect(reader.reasons()).toEqual(['open', 'reflow'])
    expect(reader.relocations()[1].opId).toBeUndefined()
  })

  it('E8 a resize that changes nothing says nothing', async () => {
    const reader = makeReader()
    await reader.open(FURTHER)
    reader.resizeNothing()
    await reader.settle()
    expect(reader.reasons()).toEqual(['open'])
  })
})

describe('real server HTML', () => {
  it('E10 newlines between blocks and nested blocks: every sentence lands on the reading line', async () => {
    const reader = makeReader({ html: REAL_CHAPTER })
    await reader.open()
    for (const sentence of ['Corran log 2', MIDDLE, 'Hollin log 4', FURTHER]) {   // Corran and Hollin are quoted
      expect(await reader.goTo(sentence)).toBe('exact')
      expect(reader.line().startsWith(sentence)).toBe(true)
    }
  })

  it('E10 a font change on real HTML keeps the place', async () => {
    const reader = makeReader({ html: REAL_CHAPTER })
    await reader.open(FURTHER)
    reader.setStyle({ fontSize: 24 })
    await reader.settle()
    expect(reader.line().startsWith(FURTHER)).toBe(true)
  })
})

describe('destroy', () => {
  it('E9 stops all events, empties the container, and a running open resolves superseded', async () => {
    const fonts = deferred()
    const reader = makeReader({ fonts: () => fonts.promise })
    const opening = reader.open()
    reader.engine.destroy()
    fonts.resolve()
    expect(await opening).toBe('superseded')
    reader.scrollBy(500)
    await reader.settle()
    expect(reader.events()).toEqual([])
    expect(reader.root.childNodes).toHaveLength(0)
    expect(reader.engine.current()).toBeNull()
  })

  it('E30 scroll anchoring stays off on a shared scroller while any engine on it lives', () => {
    // Web remounts the chapter: the next engine can be created before the last one is destroyed.
    const scroller = document.createElement('div')
    const observeResize = () => () => {}
    const a = createEngine(document.body.appendChild(document.createElement('div')), { scroller, observeResize })
    const b = createEngine(document.body.appendChild(document.createElement('div')), { scroller, observeResize })
    a.destroy()
    expect(scroller.style.overflowAnchor).toBe('none')
    b.destroy()
    expect(scroller.style.overflowAnchor).toBe('')
  })

  it('E9 gives the container back as it was (the engine positions it to draw decorations)', async () => {
    const reader = makeReader()
    await reader.open()
    expect(reader.root.style.position).toBe('relative')
    reader.engine.destroy()
    expect(reader.root.style.position).toBe('')
  })
})
