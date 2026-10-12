// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { EngineEvents, Rect } from './api'
import { CHAPTER, LAST_SENTENCE, PARAGRAPHS, destroyAll, makeReader } from './engine.testkit'
import { rangeAt } from './text'

/**
 * What the reader does with the page: select, hold, tap, scroll, reach the end. Each test name starts
 * with its rule ID (docs/05-features/reader-engine.md). The fake layout is in engine.testkit.ts.
 */

afterEach(() => { vi.useRealTimers(); destroyAll(); document.getSelection()?.removeAllRanges() })

/** One line's box on screen, the chapter scrolled by `scrollTop`. */
const onScreen = ([b]: Rect[], scrollTop: number): Rect => ({ ...b, y: b.y - scrollTop })

/** Only these events, in order. */
const only = (reader: ReturnType<typeof makeReader>, ...events: (keyof EngineEvents)[]) =>
  reader.events().filter((e) => events.includes(e))

describe('selection', () => {
  it('E20 a drag selection is sent once it settles, with its sentence, locator and box; a long one with tooLong; gone is null', async () => {
    const longSentence = `Ships ${'and more ships '.repeat(20)}sailed past the light at the far end of the long pier.`
    const tail = longSentence.slice(-150)
    const reader = makeReader({ html: `${CHAPTER}<p>${longSentence}</p>` })
    const footer = reader.footer()
    await reader.open()
    vi.useFakeTimers()
    const drag = async (sel: Parameters<typeof reader.select>[0]) => { reader.select(sel); await vi.advanceTimersByTimeAsync(300) }

    reader.select('Malin log 3: the keeper')
    await vi.advanceTimersByTimeAsync(100)
    expect(reader.payloads('selection'), 'still changing').toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    await drag('Malin log 3: the keeper')                      // the same again: not sent twice

    await drag(PARAGRAPHS.slice(12, 15).join(''))
    await drag(tail)
    const intoFooter = rangeAt(reader.chapter, reader.chapter.textContent!.indexOf(LAST_SENTENCE), 1)!
    intoFooter.setEnd(footer.firstChild!, 4)
    await drag(intoFooter)
    await drag(null)
    await drag('Oban log 2')
    const opening = reader.open()
    await vi.advanceTimersByTimeAsync(300)
    await opening

    const [short, long, inLong, toEnd, gone, again, opened, ...rest] = reader.payloads('selection') as EngineEvents['selection'][]
    expect(short).toEqual({
      text: 'Malin log 3: the keeper',
      sentence: 'Malin log 3: the keeper counted 15 ships before dawn.',
      source: 'drag',
      tooLong: false,
      locator: reader.quote('Malin log 3: the keeper'),
      rect: onScreen(reader.boxesOf('Malin log 3: the keeper'), reader.scrollTop),
    })
    expect(long).toMatchObject({ source: 'drag', tooLong: true })
    expect(inLong!.sentence, 'a long sentence is cut around the selection, never through it').toContain(tail)
    expect(toEnd!.text, 'a drag past the chapter is the part in it').toBe(LAST_SENTENCE + longSentence)
    expect(gone).toBeNull()
    expect(again).toMatchObject({ text: 'Oban log 2' })
    expect(opened, 'opening a chapter ends the selection').toBeNull()
    expect(rest).toEqual([])
  })

  it('E21 a held word is selected (hold first), marked over the text, without the page selection; moving cancels; clearSelection unmarks', async () => {
    const reader = makeReader({ html: `${CHAPTER}<p>An extra\u00ADordinary keeper’s log.</p>` })
    await reader.open()
    vi.useFakeTimers()
    const at = reader.pointAt('Malin log 3')

    reader.pointer('pointerdown', at.x, at.y)
    reader.pointer('pointermove', at.x + 10, at.y)
    await vi.advanceTimersByTimeAsync(600)
    expect(reader.events(), 'moved: a scroll, not a hold').not.toContain('hold')

    reader.pointer('pointerdown', at.x, at.y)
    await vi.advanceTimersByTimeAsync(400)
    expect(reader.events()).not.toContain('hold')
    await vi.advanceTimersByTimeAsync(100)

    expect(only(reader, 'hold', 'selection')).toEqual(['hold', 'selection'])
    expect(reader.payloads('hold')).toEqual([at])
    expect(reader.payloads('selection')).toEqual([{
      text: 'Malin',
      sentence: 'Malin log 3: the keeper counted 15 ships before dawn.',
      source: 'hold',
      tooLong: false,
      locator: reader.quote('Malin', 2),
      rect: onScreen(reader.boxesOf('Malin', 2), reader.scrollTop),
    }])
    expect(reader.drawn('selection')).toEqual([{ id: 'selection', rects: reader.boxesOf('Malin', 2) }])
    expect(document.getSelection()!.rangeCount).toBe(0)

    reader.select('Malin', 2)                                   // the platform's own long-press of the same word
    await vi.advanceTimersByTimeAsync(300)
    expect(reader.payloads('selection'), 'not sent again').toHaveLength(1)

    reader.engine.clearSelection()
    expect(reader.drawn('selection')).toEqual([])
    expect(document.getSelection()!.rangeCount).toBe(0)

    for (const word of ['extra', 'keeper’s']) {
      const p = reader.pointAt(word)
      reader.pointer('pointerdown', p.x, p.y)
      await vi.advanceTimersByTimeAsync(500)
      reader.pointer('pointerup', p.x, p.y)
    }
    expect(reader.payloads('selection').slice(1).map((s) => (s as EngineEvents['selection'])!.text), 'a whole word: soft hyphen, curly apostrophe')
      .toEqual(['extra\u00ADordinary', 'keeper’s'])
  })
})

describe('taps', () => {
  it('E22 a tap is one event: link, image, decoration or plain tap; a click ending a selection or a hold, or on the footer, is none', async () => {
    const extra = '<p>See <a href="#fn1">note 1</a> and <a href="https://example.com/x">the site</a>. <img src="fig.png" alt="Figure 1"></p>'
    const reader = makeReader({ html: CHAPTER + extra })
    await reader.open()
    reader.engine.decorate('highlight', [{ id: 'h1', locator: reader.quote('Oban log 2') }])
    const [note, site] = Array.from(reader.chapter.querySelectorAll('a'))
    const taps = () => only(reader, 'tap', 'linkClick', 'imageTap', 'decorationTap')

    expect(reader.tap(1, 1, note), 'the page does not navigate').toBe(false)
    reader.tap(1, 1, site)
    reader.tap(1, 1, reader.chapter.querySelector('img')!)
    const hl = reader.pointAt('Oban log 2')
    reader.tap(hl.x, hl.y)
    const plain = reader.pointAt('Arden log 2')
    reader.tap(plain.x, plain.y)
    expect(taps()).toEqual(['linkClick', 'linkClick', 'imageTap', 'decorationTap', 'tap'])
    expect(reader.payloads('linkClick')).toEqual([{ href: '#fn1', internal: true }, { href: 'https://example.com/x', internal: false }])
    expect(reader.payloads('imageTap')).toEqual([expect.objectContaining({ src: expect.stringMatching(/fig\.png$/), alt: 'Figure 1' })])
    expect(reader.payloads('tap')).toEqual([plain])

    reader.select('Arden log 2')
    reader.tap(plain.x, plain.y)
    reader.select(null)

    vi.useFakeTimers()
    reader.pointer('pointerdown', plain.x, plain.y)
    await vi.advanceTimersByTimeAsync(500)
    reader.pointer('pointerup', plain.x, plain.y)
    reader.tap(plain.x, plain.y)

    reader.tap(1, 1, reader.footer())
    expect(taps()).toHaveLength(5)

    reader.pointer('pointerdown', plain.x, plain.y)              // a hold the platform ends with no click
    await vi.advanceTimersByTimeAsync(500)
    reader.pointer('pointerup', plain.x, plain.y)
    reader.pointer('pointerdown', 1, 1, reader.root)             // then a tap on the page's margin
    reader.tap(1, 1)
    expect(taps()).toEqual(['linkClick', 'linkClick', 'imageTap', 'decorationTap', 'tap', 'tap'])
  })
})

describe('scrolling', () => {
  it("E23 scrollDir on a change of direction: down after 48 px, up after 6; the engine's own scrolls never", async () => {
    const reader = makeReader()
    await reader.open()
    const by = async (px: number) => { reader.scrollBy(px); await reader.settle() }

    await by(40)
    expect(reader.payloads('scrollDir')).toEqual([])
    await by(10)                 // 50 down
    await by(100)                // still down: no event
    await by(-4)
    await by(-3)                 // 7 up
    await reader.goTo('Oban log 2')
    await reader.settle()
    await by(-10)                // still up
    await by(60)

    expect(reader.payloads('scrollDir')).toEqual(['down', 'up', 'down'])
  })

  it('E24 the footer follows the chapter, outside its text; chapterEnd once per open when it shows', async () => {
    const reader = makeReader()
    const footer = reader.footer()
    await reader.open()

    expect(footer.previousElementSibling).toBe(reader.chapter)
    expect(reader.chapter.contains(footer)).toBe(false)
    expect(reader.engine.find('Next chapter')).toEqual([])

    reader.scrollBy(reader.maxScroll - 150)
    await reader.settle()
    expect(reader.events()).not.toContain('chapterEnd')
    for (const px of [150, -20, 20]) { reader.scrollBy(px); await reader.settle() }
    expect(reader.payloads('chapterEnd')).toEqual([{ visible: true }])

    await reader.open()
    await reader.goTo(LAST_SENTENCE)
    await reader.settle()
    expect(reader.payloads('chapterEnd')).toHaveLength(2)

    reader.engine.setFooter(null)
    expect(footer.isConnected).toBe(false)

    const short = makeReader()
    short.footer()
    await short.open()
    short.setStyle({ fontSize: 4 })                             // the chapter shrinks: the footer shows, no scroll
    await short.settle()
    expect(short.payloads('chapterEnd')).toEqual([{ visible: true }])
  })
})
