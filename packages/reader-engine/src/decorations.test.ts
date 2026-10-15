// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { CHAPTER, destroyAll, makeReader } from './engine.testkit'
import { chapterText, textNodes } from './text'

/**
 * Decorations: highlights, search hits and saved words, drawn over the text. Each test name starts
 * with its rule ID (docs/05-features/reader-engine.md). The fake layout is in engine.testkit.ts.
 */

const browserClientRects = Range.prototype.getClientRects
afterEach(() => {
  destroyAll()
  vi.restoreAllMocks()
  expect(Range.prototype.getClientRects).toBe(browserClientRects)   // `browserBoxes` never outlives its reader
})

const MIDDLE = 'Malin log 3'

describe('decorate', () => {
  it('E13 draws a highlight over its text and leaves the text untouched', async () => {
    const reader = makeReader()
    await reader.open()
    const nodes = textNodes(reader.chapter)
    const html = reader.chapter.innerHTML

    reader.engine.decorate('highlight', [{ id: 'h1', locator: reader.quote(MIDDLE) }])

    expect(reader.drawn('highlight')).toEqual([{ id: 'h1', rects: reader.boxesOf(MIDDLE) }])
    expect(reader.chapter.innerHTML).toBe(html)
    expect(textNodes(reader.chapter)).toEqual(nodes)
    expect(chapterText(reader.root)).toBe(chapterText(reader.chapter))
  })

  it('E13 a box with no area (a line end, a column edge) is not drawn', async () => {
    const reader = makeReader({ browserBoxes: true })
    await reader.open()

    reader.engine.decorate('highlight', [{ id: 'h1', locator: reader.quote(MIDDLE) }])

    expect(reader.drawn('highlight')).toEqual([{ id: 'h1', rects: reader.boxesOf(MIDDLE) }])
  })

  it('E13 a new call replaces its own group and leaves the other', async () => {
    const reader = makeReader()
    await reader.open()
    reader.engine.decorate('highlight', [{ id: 'h1', locator: reader.quote('Arden log 1') }, { id: 'h2', locator: reader.quote('Brill log 1') }])
    reader.engine.decorate('search', [{ id: 's1', locator: reader.quote('Corran log 1') }])

    reader.engine.decorate('highlight', [{ id: 'h3', locator: reader.quote('Dunmore log 1') }])

    expect(reader.drawn('highlight').map((d) => d.id)).toEqual(['h3'])
    expect(reader.drawn('search').map((d) => d.id)).toEqual(['s1'])
  })

  it('E31 the style "dot" draws a dot just after the last line, not a fill; a tap on its text names it', async () => {
    const reader = makeReader()
    await reader.open()
    reader.engine.decorate('highlight', [{ id: 'h1', locator: reader.quote(MIDDLE), style: 'dot' }])

    expect(reader.drawn('highlight')).toEqual([{ id: 'h1', rects: [] }])
    const dot = reader.root.querySelector('[data-group="highlight"] circle')!
    const last = reader.boxesOf(MIDDLE).at(-1)!
    expect(Number(dot.getAttribute('cx'))).toBeGreaterThan(last.x + last.width)
    expect(Number(dot.getAttribute('cy'))).toBeGreaterThan(last.y)
    expect(Number(dot.getAttribute('cy'))).toBeLessThan(last.y + last.height)

    reader.tap(last.x + 1, last.y + 1)
    expect(reader.payloads('decorationTap')).toMatchObject([{ group: 'highlight', id: 'h1' }])
  })

  it("E14 another chapter's item, or text that is gone, is not drawn", async () => {
    const reader = makeReader()
    await reader.open()
    reader.engine.decorate('highlight', [
      { id: 'other', locator: reader.quote(MIDDLE, 0, 'chapter-9') },
      { id: 'gone', locator: { ...reader.quote(MIDDLE), text: { highlight: 'Atlantis sank beneath the waves at noon.' } } },
      { id: 'here', locator: reader.quote('Oban log 2') },
    ])
    expect(reader.drawn('highlight').map((d) => d.id)).toEqual(['here'])
  })
})

describe('decorations follow the text', () => {
  it('E15 after a style change they are drawn where the text moved', async () => {
    const reader = makeReader()
    await reader.open()
    reader.engine.decorate('highlight', [{ id: 'h1', locator: reader.quote(MIDDLE) }])
    const before = reader.boxesOf(MIDDLE)

    reader.setStyle({ fontSize: 24 })
    await reader.settle()

    expect(reader.boxesOf(MIDDLE)).not.toEqual(before)
    expect(reader.drawn('highlight')).toEqual([{ id: 'h1', rects: reader.boxesOf(MIDDLE) }])
  })

  it('E15 after the chapter grows late (an image above) they move down with it', async () => {
    const reader = makeReader()
    await reader.open()
    reader.engine.decorate('search', [{ id: 's1', locator: reader.quote(MIDDLE) }])

    reader.grow('Arden log 1', 300)
    await reader.settle()

    expect(reader.drawn('search')).toEqual([{ id: 's1', rects: reader.boxesOf(MIDDLE) }])
    expect(reader.drawn('search')[0].rects[0].y).toBeGreaterThan(300)
  })

  it('E15 they belong to their chapter: opening another draws its own, coming back draws these again', async () => {
    const reader = makeReader()
    await reader.open()
    reader.engine.decorate('highlight', [
      { id: 'in-c1', locator: reader.quote(MIDDLE) },
      { id: 'in-c2', locator: reader.quote('Oban log 2', 0, 'c2') },
    ])
    expect(reader.drawn('highlight').map((d) => d.id)).toEqual(['in-c1'])

    await reader.engine.open({ href: 'c2', layout: 'reflow', html: CHAPTER })
    expect(reader.drawn('highlight').map((d) => d.id)).toEqual(['in-c2'])

    await reader.open()
    expect(reader.drawn('highlight').map((d) => d.id)).toEqual(['in-c1'])
  })
})

describe('decorationTap', () => {
  it('E16 a tap on a highlight names it, with its box on screen', async () => {
    const reader = makeReader()
    await reader.open(MIDDLE)
    expect(reader.scrollTop).toBeGreaterThan(0)
    reader.engine.decorate('highlight', [{ id: 'h1', locator: reader.quote(MIDDLE) }])
    const [box] = reader.boxesOf(MIDDLE)

    reader.tap(box.x + 5, box.y - reader.scrollTop + 5)

    expect(reader.payloads('decorationTap')).toEqual([
      { group: 'highlight', id: 'h1', rect: { ...box, y: box.y - reader.scrollTop } },
    ])
  })

  it('E16 a highlight under a search hit wins the tap', async () => {
    const reader = makeReader()
    await reader.open()
    reader.engine.decorate('highlight', [{ id: 'h1', locator: reader.quote(MIDDLE) }])
    reader.engine.decorate('search', [{ id: 's1', locator: reader.quote(MIDDLE) }])
    const [box] = reader.boxesOf(MIDDLE)

    reader.tap(box.x + 5, box.y + 5)

    expect(reader.payloads('decorationTap')).toMatchObject([{ group: 'highlight', id: 'h1' }])
  })

  it('E16 the click that ends a text selection is not a tap', async () => {
    const reader = makeReader()
    await reader.open()
    reader.engine.decorate('highlight', [{ id: 'h1', locator: reader.quote(MIDDLE) }])
    const [box] = reader.boxesOf(MIDDLE)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.selectAllChildren(reader.chapter.querySelector('p')!)

    reader.tap(box.x + 5, box.y + 5)
    selection.removeAllRanges()

    expect(reader.payloads('decorationTap')).toEqual([])
  })

  it('E16 a tap on plain text says nothing', async () => {
    const reader = makeReader()
    await reader.open()
    reader.engine.decorate('highlight', [{ id: 'h1', locator: reader.quote(MIDDLE) }])
    const [box] = reader.boxesOf('Arden log 1')

    reader.tap(box.x + 5, box.y + 5)

    expect(reader.payloads('decorationTap')).toEqual([])
  })
})

describe('find', () => {
  it('E17 finds every match in reading order, any case, each one a place goTo and decorate land on', async () => {
    const reader = makeReader()
    await reader.open()

    const hits = reader.engine.find('COUNTED 7 SHIPS')

    expect(hits.map((h) => h.locator.text?.highlight)).toEqual(Array(4).fill('counted 7 ships'))
    expect(hits.map((h) => h.locator.locations.charOffset)).toEqual([...hits.map((h) => h.locator.locations.charOffset!)].sort((a, b) => a - b))
    expect(await reader.goTo(hits[2].locator)).toBe('exact')
    reader.engine.decorate('search', hits.map((h, i) => ({ id: String(i), locator: h.locator })))
    expect(reader.drawn('search')).toEqual(hits.map((_, i) => ({ id: String(i), rects: reader.boxesOf('counted 7 ships', i) })))
  })

  it('E17 each match comes with the text around it', async () => {
    const reader = makeReader()
    await reader.open()
    const [hit] = reader.engine.find(MIDDLE)
    expect(hit.context).toMatch(/^\.\.\..{40}Malin log 3.{40}\.\.\.$/)
  })

  it('E17 a no-break space matches a space; an empty query finds nothing', async () => {
    const reader = makeReader()
    await reader.open()
    expect(reader.engine.find('Malin log 3')).toHaveLength(1)
    expect(reader.engine.find('')).toEqual([])
  })

  it('E49 a composed letter matches its decomposed form, either way round', async () => {
    const reader = makeReader({ html: '<p>Un cafe\u0301 noir, un caf\u00e9 au lait.</p>' })
    await reader.open()

    expect(reader.engine.find('caf\u00e9').map((h) => h.locator.text?.highlight)).toEqual(['cafe\u0301', 'caf\u00e9'])
    expect(reader.engine.find('cafe\u0301').map((h) => h.locator.text?.highlight)).toEqual(['cafe\u0301', 'caf\u00e9'])
  })

  it('E50 a hit after a letter whose lowercase is longer (Turkish İ) is quoted at its own place in the text', async () => {
    const reader = makeReader({ html: '<p>İstanbul has the keeper, and the keeper counted.</p>' })
    await reader.open()

    const hits = reader.engine.find('KEEPER')

    expect(hits.map((h) => h.locator.text?.highlight)).toEqual(['keeper', 'keeper'])
    expect(hits.map((h) => h.locator.locations.charOffset)).toEqual([17, 33])
    expect(reader.engine.find('İSTANBUL HAS').map((h) => h.locator.text?.highlight)).toEqual(['İstanbul has'])
  })
})

describe('testkit browserBoxes', () => {
  it("fakes boxes for its reader's ranges only, and its destroy puts the page's own back", async () => {
    const PAGE = [] as unknown as DOMRectList
    const page = () => PAGE   // what the page answered before (another testkit's stub, a browser)
    Range.prototype.getClientRects = page
    try {
      const reader = makeReader({ browserBoxes: true })
      await reader.open()
      const outside = document.createRange()
      outside.selectNodeContents(document.body.appendChild(document.createElement('p')))
      expect(outside.getClientRects()).toBe(PAGE)
      expect(reader.root.ownerDocument.createRange().getClientRects).not.toBe(page)

      reader.engine.destroy()
      expect(Range.prototype.getClientRects).toBe(page)
    } finally {
      if (browserClientRects) Range.prototype.getClientRects = browserClientRects
      else delete (Range.prototype as Partial<Range>).getClientRects   // jsdom has none
    }
  })
})

describe('markWords', () => {
  it('E18 underlines a saved word wherever it stands as a whole word, in any case', async () => {
    const reader = makeReader()
    await reader.open()

    reader.engine.markWords([{ word: 'KEEPER', style: 'blue' }, { word: 'count' }], false)

    const marks = reader.drawn('word')
    expect(marks).toHaveLength(120)   // "keeper" four times in each of 30 paragraphs; "count" only inside "counted"
    const [box] = reader.boxesOf('keeper')
    expect(marks[0].rects[0]).toMatchObject({ x: box.x, width: box.width })
    expect(marks[0].rects[0].y).toBeGreaterThan(box.y)   // under the word, not over it
  })

  it('E18 a block or a footnote ends a word: words on either side of one are still found', async () => {
    const reader = makeReader({ html: '<p>The keeper stood here</p><p>Next came word<sup>1</sup> again</p>' })
    await reader.open()

    reader.engine.markWords([{ word: 'here' }, { word: 'next' }, { word: 'word' }], false)

    expect(reader.drawn('word').map((d) => d.id)).toEqual(['here', 'next', 'word'])
  })

  it('E18 thousands of marks draw with one chapter walk and one Range, not one of each per mark', async () => {
    const reader = makeReader()
    await reader.open()
    const walks = vi.spyOn(document, 'createTreeWalker')
    const ranges = vi.spyOn(document, 'createRange')

    reader.engine.markWords([{ word: 'keeper' }, { word: 'ships' }], false)

    expect(reader.drawn('word')).toHaveLength(240)
    // 1 walk to match the words, 1 to place them; 1 Range reused. Before: 2 walks + 1 Range per mark —
    // seconds on a long chapter (every live Range is updated on each DOM change).
    // At most 2 over the whole chapter, however many marks (the fake layout walks single paragraphs).
    expect(walks.mock.calls.filter(([root]) => root === reader.chapter).length).toBeLessThanOrEqual(2)
    expect(ranges).toHaveBeenCalledTimes(1)
  })

  it('E18 with nothing to draw, a style change or a reflow does not walk the chapter', async () => {
    const reader = makeReader()
    await reader.open()
    const walks = vi.spyOn(document, 'createTreeWalker')

    reader.setStyle({ fontSize: 20 })
    reader.grow('Arden log 1', 100)
    await reader.settle()

    expect(walks.mock.calls.filter(([root]) => root === reader.chapter)).toEqual([])
  })

  it('E18 a saved phrase is marked whole, not also as its words; a new call replaces the set', async () => {
    const reader = makeReader()
    await reader.open()

    reader.engine.markWords([{ word: 'dawn' }, { word: 'before dawn' }], false)
    expect(reader.drawn('word').map((d) => d.id)).toEqual(Array(120).fill('before dawn'))

    reader.engine.markWords([{ word: 'ships' }], false)
    expect(reader.drawn('word').map((d) => d.id)).toEqual(Array(120).fill('ships'))
  })

  it('E19 with translations on, each one is drawn above its word, and the chapter text stays the same', async () => {
    const reader = makeReader()
    await reader.open(MIDDLE)
    const nodes = textNodes(reader.chapter)
    const text = chapterText(reader.root)
    const here = reader.engine.current()

    reader.engine.markWords([{ word: 'keeper', translation: 'хранитель' }, { word: 'ships' }], true)

    const labels = reader.translations()
    expect(labels).toHaveLength(120)   // "ships" has no translation
    const [box] = reader.boxesOf('keeper')
    expect(labels[0]).toMatchObject({ text: 'хранитель', x: box.x + box.width / 2 })
    expect(labels[0].y).toBeLessThanOrEqual(box.y)
    expect(reader.root.querySelector('text')!.getAttribute('fill')).toBe('currentColor')   // the theme's text colour
    expect(textNodes(reader.chapter)).toEqual(nodes)
    expect(chapterText(reader.root)).toBe(text)
    expect(reader.engine.current()).toEqual(here)
  })

  it('E44 a translation carries its own look: small, italic, sans-serif, faint; no host CSS needed', async () => {
    const reader = makeReader()
    await reader.open()
    reader.engine.markWords([{ word: 'keeper', translation: 'хранитель' }], true)
    const label = reader.root.querySelector('text')!
    // One `font` shorthand, weight included: a bold chapter root never leaks into the label.
    expect(label.getAttribute('style')).toBe('font: italic 400 0.42em -apple-system, system-ui, sans-serif; opacity: .55')
  })

  it('E19 with translations off, words are underlined and no translation is drawn', async () => {
    const reader = makeReader()
    await reader.open()
    reader.engine.markWords([{ word: 'keeper', translation: 'хранитель' }], false)
    expect(reader.drawn('word')).toHaveLength(120)
    expect(reader.translations()).toEqual([])
  })
})
