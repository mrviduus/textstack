import { describe, it, expect } from 'vitest'
import web from '../../shared/src/reader/__fixtures__/anchors/web.json'
import mobile from '../../shared/src/reader/__fixtures__/anchors/mobile.json'
import mcp from '../../shared/src/reader/__fixtures__/anchors/mcp.json'
import positions from '../../shared/src/reader/__fixtures__/stored/positions.json'
import pdf from '../../shared/src/reader/__fixtures__/stored/pdf.json'
import locators from '../../shared/src/reader/__fixtures__/stored/locators.json'
import { parseTextPosition, serializeTextPosition } from '../../shared/src/reader/textPosition'
import type { Locator } from './api'
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
    expect(anchorToLocator(pdf['one-line'], 'x')).toBeNull()
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

describe('a stored value is written back only when nothing changed (review of #775)', () => {
  const posJson = positions['mid-chapter']

  it('a moved locator writes a fresh position, not the one it was read from', () => {
    const loc = positionToLocator(posJson)!
    const moved = { ...loc, locations: { ...loc.locations, progression: 0.6, charOffset: 200 }, text: { before: 'a', highlight: 'new quote', after: 'b' } }
    const json = locatorToPosition(moved)!
    expect(json).not.toBe(posJson)
    expect(parseTextPosition(json)).toMatchObject({ chapterFraction: 0.6, charOffset: 200, anchor: { exact: 'new quote' } })
  })

  it('a value of one kind is never written back as another kind', () => {
    expect(locatorToPosition(progressToLocator('chapter:chapter-two'))).toBeNull()
    expect(locatorToAnchor(positionToLocator(posJson))).not.toBe(posJson)
    expect(locatorToProgress(positionToLocator(posJson))).toBeNull()
    expect(locatorToPdfAnchor(progressToLocator('page:7'))).toBeNull()
  })
})

describe('fresh writes only produce values the readers accept (review of #775)', () => {
  it('a position clamps progression and needs a charOffset', () => {
    const base = { href: 'c', type: 'text/html' as const, text: { highlight: 'x' } }
    expect(parseTextPosition(locatorToPosition({ ...base, locations: { progression: 1.02, charOffset: 0 } }))?.chapterFraction).toBe(1)
    const nan = locatorToPosition({ ...base, locations: { progression: Number.NaN, charOffset: 0 } })!
    expect(serializeTextPosition(parseTextPosition(nan))).toBe(nan)
    expect(locatorToPosition({ ...base, locations: { progression: 0.5 } })).toBeNull()
  })

  it('a reflow progress locator needs legacyScrollY; never silently "start of chapter"', () => {
    expect(locatorToProgress({ href: 'c', type: 'text/html', locations: { progression: 0.4, charOffset: 9 } })).toBeNull()
  })

  it('a PDF page must be a whole page >= 1', () => {
    for (const position of [0.5, 0, -3, Number.NaN]) {
      expect(locatorToProgress({ type: 'application/pdf', locations: { position } })).toBeNull()
      expect(locatorToPdfAnchor({ type: 'application/pdf', locations: { position }, text: { highlight: 'x' }, ext: { rects: [] } })).toBeNull()
    }
  })

  it('a malformed stored PDF anchor reads as nothing', () => {
    for (const bad of ['{"kind":"pdf"}', '{"v":1,"kind":"pdf","page":0,"rects":[],"exact":"x"}', '{"v":1,"kind":"pdf","page":2,"exact":"x"}']) {
      expect(pdfAnchorToLocator(bad)).toBeNull()
    }
  })
})

describe('the Locator alone carries the meaning (review of #775)', () => {
  const strip = (l: Locator | null): Locator => ({ ...l!, ext: l!.ext?.rects ? { rects: l!.ext.rects } : undefined })

  for (const [name, json] of Object.entries(positions)) {
    it(`position ${name}: rebuilt from fields alone, without the stored value`, () => {
      expect(locatorToPosition(strip(positionToLocator(json)))).toBe(json)
    })
  }
  for (const [name, json] of Object.entries(pdf)) {
    it(`pdf ${name}: rebuilt from fields alone, without the stored value`, () => {
      expect(locatorToPdfAnchor(strip(pdfAnchorToLocator(json)))).toBe(json)
    })
  }

  it('a moved MCP highlight keeps chapterId and source, so the assistant write cap still counts it', () => {
    const json = JSON.stringify(mcp['inline-tags'])
    const loc = anchorToLocator(json, 'chapter-one')!
    const moved = { ...loc, locations: { charOffset: 12 }, text: { ...loc.text, before: 'It was a ' } }
    const out = JSON.parse(locatorToAnchor(moved)!)
    expect(out).toMatchObject({ prefix: 'It was a ', startOffset: 12, chapterId: mcp['inline-tags'].chapterId, source: 'mcp' })
  })
})

describe('final review of #775', () => {
  it('reads the finished/start sentinels and web percent as a book fraction', () => {
    expect(progressToLocator('{"type":"end"}')).toMatchObject({ locations: { totalProgression: 1 } })
    expect(progressToLocator('{"type":"start"}')).toMatchObject({ locations: { totalProgression: 0 } })
    expect(progressToLocator('percent:0.4200')).toMatchObject({ locations: { totalProgression: 0.42 } })
    expect(progressToLocator('percent:1.5')).toBeNull()
  })

  it('a highlight moved to another chapter drops the old chapterId, keeps source', () => {
    const loc = anchorToLocator(JSON.stringify(mcp['inline-tags']), 'chapter-one')!
    const out = JSON.parse(locatorToAnchor({ ...loc, href: 'chapter-two', locations: { charOffset: 3 } })!)
    expect(out.chapterId).toBeUndefined()
    expect(out.source).toBe('mcp')
  })

  it('PDF rects must be {x,y,w,h} numbers both ways', () => {
    expect(pdfAnchorToLocator('{"v":1,"kind":"pdf","page":2,"rects":[{"left":1,"top":2,"width":3,"height":4}],"exact":"x"}')).toBeNull()
    expect(locatorToPdfAnchor({ type: 'application/pdf', locations: { position: 2 }, text: { highlight: 'x' },
      ext: { rects: [{ left: 1, top: 2, width: 3, height: 4 } as never] } })).toBeNull()
  })
})
