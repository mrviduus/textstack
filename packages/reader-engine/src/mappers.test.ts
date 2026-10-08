import { describe, it, expect } from 'vitest'
import web from '../../shared/src/reader/__fixtures__/anchors/web.json'
import mobile from '../../shared/src/reader/__fixtures__/anchors/mobile.json'
import mcp from '../../shared/src/reader/__fixtures__/anchors/mcp.json'
import positions from '../../shared/src/reader/__fixtures__/stored/positions.json'
import pdf from '../../shared/src/reader/__fixtures__/stored/pdf.json'
import locators from '../../shared/src/reader/__fixtures__/stored/locators.json'
import { parseTextPosition, serializeTextPosition } from '../../shared/src/reader/textPosition'
import {
  anchorToLocator, locatorToAnchor,
  positionToLocator, locatorToPosition,
  pdfAnchorToLocator, locatorToPdfAnchor,
  progressToLocator, locatorToProgress,
} from './mappers'

/**
 * Stored shapes are frozen (ADR-025 §5): every value already written by web, the phone or MCP must
 * come back byte-identical, and the Locator built from it must say the same thing in Readium terms.
 */

const rows = (file: Record<string, unknown>) => Object.entries(file).map(([name, v]) => [name, JSON.stringify(v)] as const)

describe('TextAnchor ↔ Locator', () => {
  for (const [producer, file] of [['web', web], ['mobile', mobile], ['mcp', mcp]] as const) {
    for (const [name, json] of rows(file)) {
      it(`${producer}/${name}: round-trips byte-identically`, () => {
        expect(locatorToAnchor(anchorToLocator(json, 'chapter-one'))).toBe(json)
      })
      it(`${producer}/${name}: reads as a TextQuoteSelector`, () => {
        const a = JSON.parse(json)
        const loc = anchorToLocator(json, 'chapter-one')!
        expect(loc.href).toBe('chapter-one')
        expect(loc.type).toBe('text/html')
        expect(loc.text).toEqual({ before: a.prefix ?? '', highlight: a.exact, after: a.suffix ?? '' })
        if (typeof a.startOffset === 'number') expect(loc.locations.charOffset).toBe(a.startOffset)
        else expect(loc.locations.charOffset).toBeUndefined()
      })
    }
  }

  it('a fresh locator writes the web shape, offsets from the quote', () => {
    const json = locatorToAnchor({
      href: 'chapter-one', type: 'text/html',
      locations: { charOffset: 10 },
      text: { before: 'It was a ', highlight: 'bright cold day', after: ' in April' },
    })
    expect(json).toBe('{"prefix":"It was a ","exact":"bright cold day","suffix":" in April","startOffset":10,"endOffset":25}')
  })

  it('rejects what is not an anchor', () => {
    expect(anchorToLocator('not json', 'x')).toBeNull()
    expect(anchorToLocator('{"prefix":"a"}', 'x')).toBeNull()
    expect(anchorToLocator(JSON.stringify(JSON.parse(pdf['one-line'])), 'x')).toBeNull()
  })
})

describe('TextPosition ↔ Locator', () => {
  for (const [name, json] of Object.entries(positions)) {
    it(`${name}: the fixture is what the writer emits`, () => {
      expect(serializeTextPosition(parseTextPosition(json))).toBe(json)
    })
    it(`${name}: round-trips byte-identically`, () => {
      expect(locatorToPosition(positionToLocator(json))).toBe(json)
    })
    it(`${name}: reads as a Readium locator`, () => {
      const p = JSON.parse(json)
      const loc = positionToLocator(json)!
      expect(loc.href).toBe(p.chapterSlug)
      expect(loc.locations.progression).toBe(p.chapterFraction)
      expect(loc.locations.charOffset).toBe(p.charOffset)
      expect(loc.text?.highlight).toBe(p.anchor.exact)
    })
  }

  it('a fresh locator writes the v1 writer shape', () => {
    const fresh = {
      href: 'chapter-one', type: 'text/html' as const,
      locations: { progression: 0.5, charOffset: 3 },
      text: { before: 'abc', highlight: 'defg', after: 'hij' },
    }
    const json = locatorToPosition(fresh)!
    expect(json).toBe('{"v":1,"chapterSlug":"chapter-one","anchor":{"prefix":"abc","exact":"defg","suffix":"hij","startOffset":3,"endOffset":7},"charOffset":3,"chapterFraction":0.5}')
    expect(serializeTextPosition(parseTextPosition(json))).toBe(json)
  })

  it('refuses a position it cannot read, and a locator with no chapter or text', () => {
    expect(positionToLocator('{"v":2,"chapterSlug":"a","anchor":{"exact":"x"}}')).toBeNull()
    expect(locatorToPosition({ type: 'text/html', locations: {}, text: { highlight: 'x' } })).toBeNull()
    expect(locatorToPosition({ href: 'a', type: 'text/html', locations: {} })).toBeNull()
  })
})

describe('PdfAnchor ↔ Locator', () => {
  for (const [name, json] of Object.entries(pdf)) {
    it(`${name}: round-trips byte-identically`, () => {
      expect(locatorToPdfAnchor(pdfAnchorToLocator(json))).toBe(json)
    })
    it(`${name}: reads as a page with rects`, () => {
      const a = JSON.parse(json)
      const loc = pdfAnchorToLocator(json)!
      expect(loc.href).toBeUndefined()
      expect(loc.type).toBe('application/pdf')
      expect(loc.locations.position).toBe(a.page)
      expect(loc.text?.highlight).toBe(a.exact)
      expect(loc.ext?.rects).toEqual(a.rects)
    })
  }

  it('a fresh locator writes the stored shape', () => {
    expect(locatorToPdfAnchor({
      type: 'application/pdf', locations: { position: 3 }, text: { highlight: 'hi' },
      ext: { rects: [{ x: 1, y: 2, w: 3, h: 4 }] },
    })).toBe('{"v":1,"kind":"pdf","page":3,"rects":[{"x":1,"y":2,"w":3,"h":4}],"exact":"hi"}')
  })
})

describe('progress locator strings ↔ Locator', () => {
  for (const [name, s] of Object.entries(locators)) {
    it(`${name}: round-trips`, () => {
      expect(locatorToProgress(progressToLocator(s))).toBe(s)
    })
  }

  it('reads each kind', () => {
    expect(progressToLocator('page:7')).toMatchObject({ type: 'application/pdf', locations: { position: 7 } })
    expect(progressToLocator('chapter:chapter-two')).toMatchObject({ href: 'chapter-two', locations: { progression: 0 } })
    expect(progressToLocator('scroll:part-1:chapter-2:0')).toMatchObject({ href: 'part-1:chapter-2', locations: { legacyScrollY: 0 } })
  })

  it('a fresh reflow locator writes the legacy scroll locator, a fresh PDF one a page', () => {
    expect(locatorToProgress({ href: 'c', type: 'text/html', locations: { legacyScrollY: 120.6 } })).toBe('scroll:c:121')
    expect(locatorToProgress({ type: 'application/pdf', locations: { position: 4 } })).toBe('page:4')
  })

  it('rejects garbage', () => {
    for (const s of ['', 'page:0', 'page:x', 'scroll:c:-1', 'chapter:', 'hello']) expect(progressToLocator(s)).toBeNull()
  })
})
