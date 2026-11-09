import { describe, it, expect } from 'vitest'
import web from '../../shared/src/reader/__fixtures__/anchors/web.json'
import mobile from '../../shared/src/reader/__fixtures__/anchors/mobile.json'
import mcp from '../../shared/src/reader/__fixtures__/anchors/mcp.json'
import { ANCHOR_CASES, PRODUCER_ONLY_CASES, caseStart, chapterById } from '../../shared/src/reader/__fixtures__/anchors/chapters'
import type { Locator } from './api'
import { anchorToLocator } from './mappers'
import { resolveLocator } from './resolve'

/**
 * The `goTo` resolution ladder (ADR-025 `GoToResult`), most confident first:
 * the quoted text → the chapter fraction → the legacy pixel offset → the top.
 * Rule ids (L1…) are in the test names.
 */

const CHAPTER =
  'It was a bright cold day in April, and the clocks were striking thirteen. ' +
  'Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, ' +
  'slipped quickly through the glass doors of Victory Mansions, though not quickly enough ' +
  'to prevent a swirl of gritty dust from entering along with him.'

/** A reading position at `at`, quoted the way buildTextPosition quotes it (30 / 64 / 30). */
const quote = (text: string, at: number, extra: Partial<Locator['locations']> = {}): Locator => ({
  href: 'c1',
  type: 'text/html',
  locations: { charOffset: at, progression: at / text.length, ...extra },
  text: { before: text.slice(Math.max(0, at - 30), at), highlight: text.slice(at, at + 64), after: text.slice(at + 64, at + 94) },
})

describe('resolveLocator', () => {
  it('L1 unchanged text: exact, at the quoted offset', () => {
    expect(resolveLocator(quote(CHAPTER, 100), 'c1', CHAPTER)).toEqual({ result: 'exact', offset: 100 })
  })

  it('L1 text inserted before the passage: still exact, at the new offset', () => {
    const shifted = 'A RECOVERED EPIGRAPH. ' + CHAPTER
    expect(resolveLocator(quote(CHAPTER, 100), 'c1', shifted)).toEqual({ result: 'exact', offset: 122 })
  })

  it('L2 the passage itself was edited: fuzzy', () => {
    const fixed = CHAPTER.replace('glass doors', 'glass door')
    expect(resolveLocator(quote(CHAPTER, 150), 'c1', fixed)?.result).toBe('fuzzy')
  })

  it("L3 another chapter's locator resolves to nothing here, never to a look-alike place (ADR-015)", () => {
    expect(resolveLocator(quote(CHAPTER, 100), 'c2', CHAPTER)).toBeNull()
  })

  it('L4 text gone: the chapter fraction, clamped', () => {
    const gone = 'a completely different chapter entirely'
    expect(resolveLocator(quote(CHAPTER, 100, { progression: 0.4 }), 'c1', gone)).toEqual({ result: 'fraction', fraction: 0.4 })
    expect(resolveLocator({ href: 'c1', type: 'text/html', locations: { progression: 1.3 } }, 'c1', gone)).toEqual({ result: 'fraction', fraction: 1 })
  })

  it('L5 only the old pixel offset: legacyOffset, and only as the last fallback', () => {
    const legacy: Locator = { href: 'c1', type: 'text/html', locations: { legacyScrollY: 5686 } }
    expect(resolveLocator(legacy, 'c1', CHAPTER)).toEqual({ result: 'legacyOffset', scrollY: 5686 })
    expect(resolveLocator({ ...legacy, locations: { legacyScrollY: 5686, progression: 0.3 } }, 'c1', CHAPTER))
      .toEqual({ result: 'fraction', fraction: 0.3 })
  })

  it('L6 nothing to go on: the start (`chapter:<slug>`, scroll 0, no locator)', () => {
    expect(resolveLocator({ href: 'c1', type: 'text/html', locations: { progression: 0 } }, 'c1', CHAPTER)).toEqual({ result: 'start' })
    expect(resolveLocator({ href: 'c1', type: 'text/html', locations: { legacyScrollY: 0 } }, 'c1', CHAPTER)).toEqual({ result: 'start' })
    expect(resolveLocator(undefined, 'c1', CHAPTER)).toEqual({ result: 'start' })
  })
})

describe('L7 charOffset only breaks a tie (ADR-025 spike finding)', () => {
  it('two occurrences with identical context: the hint picks the one the reader was at', () => {
    const twice = CHAPTER + ' ' + CHAPTER
    const second = CHAPTER.length + 1 + 100
    expect(resolveLocator(quote(twice, second), 'c1', twice)).toEqual({ result: 'exact', offset: second })
  })

  it('never invents a place: text gone falls to the fraction even with a hint', () => {
    expect(resolveLocator(quote(CHAPTER, 100, { progression: 0.4 }), 'c1', 'unrelated')?.result).toBe('fraction')
  })

  // Every producer's frozen anchor, resolved with its own hint, with a wrong hint (0, what an
  // offset-less phone anchor became under the old tie-break) and with none: a context-unique match
  // always wins. The old resolver failed `repeated-second` and `edge-repeat-end` here.
  const chapterText = (id: string) => chapterById(id).html.replace(/<[^>]+>/g, '')
  for (const [producer, file] of [['web', web], ['mobile', mobile], ['mcp', mcp]] as const) {
    for (const [name, anchor] of Object.entries(file)) {
      const c = ANCHOR_CASES.find((x) => x.name === name)
      const text = chapterText(c?.chapter ?? ANCHOR_CASES[0].chapter)
      const want = c ? caseStart(text, c) : text.indexOf(PRODUCER_ONLY_CASES[name])
      it(`${producer}/${name}`, () => {
        const loc = anchorToLocator(JSON.stringify(anchor), 'c1')!
        for (const charOffset of [loc.locations.charOffset, 0, undefined]) {
          const r = resolveLocator({ ...loc, locations: { charOffset } }, 'c1', text)
          expect(r && 'offset' in r ? r.offset : r, `hint ${charOffset}`).toBe(want)
        }
      })
    }
  }
})
