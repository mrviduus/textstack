import { describe, it, expect } from 'vitest'
import {
  buildTextPosition,
  serializeTextPosition,
  parseTextPosition,
  resolveTextPosition,
  TEXT_POSITION_VERSION,
  POSITION_QUOTE_LENGTH,
  MAX_SERIALISED_LENGTH,
} from './textPosition'

const CHAPTER =
  'It was a bright cold day in April, and the clocks were striking thirteen. ' +
  'Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, ' +
  'slipped quickly through the glass doors of Victory Mansions, though not quickly enough ' +
  'to prevent a swirl of gritty dust from entering along with him. ' +
  'The hallway smelt of boiled cabbage and old rag mats. At one end of it a coloured poster, ' +
  'too large for indoor display, had been tacked to the wall.'

const at = (n: number) => buildTextPosition({
  chapterSlug: '1-part-one', chapterText: CHAPTER, charOffset: n, chapterFraction: n / CHAPTER.length,
})!

describe('buildTextPosition', () => {
  it('quotes the reading line with context either side', () => {
    const pos = at(150)
    expect(pos.v).toBe(TEXT_POSITION_VERSION)
    expect(pos.chapterSlug).toBe('1-part-one')
    expect(pos.anchor.exact).toHaveLength(POSITION_QUOTE_LENGTH)
    expect(pos.anchor.prefix).toHaveLength(30)   // ANCHOR_CONTEXT_LENGTH, shared with highlights
    expect(pos.anchor.suffix).toHaveLength(30)
    expect(CHAPTER.slice(pos.charOffset)).toContain(pos.anchor.exact)
  })

  it('has nothing to anchor to past the end of the chapter', () => {
    // The fraction still says where the reader is; only the precision is lost.
    expect(buildTextPosition({
      chapterSlug: 'x', chapterText: CHAPTER, charOffset: CHAPTER.length, chapterFraction: 1,
    })).toBeNull()
  })

  it('refuses to build without a chapter or without text', () => {
    expect(buildTextPosition({ chapterSlug: '', chapterText: CHAPTER, charOffset: 0, chapterFraction: 0 })).toBeNull()
    expect(buildTextPosition({ chapterSlug: 'x', chapterText: '', charOffset: 0, chapterFraction: 0 })).toBeNull()
  })
})

describe('serialize / parse', () => {
  it('round-trips', () => {
    const pos = at(150)
    expect(parseTextPosition(serializeTextPosition(pos))).toEqual(pos)
  })

  it('rejects a version it does not know — which is what the version is for', () => {
    const json = JSON.stringify({ ...at(150), v: 99 })
    expect(parseTextPosition(json)).toBeNull()
  })

  it('rejects garbage rather than half-parsing it', () => {
    for (const bad of [null, undefined, '', 'not json', '{}', '[]', '"a string"',
                       JSON.stringify({ v: 1, chapterSlug: 'x' }),
                       JSON.stringify({ v: 1, chapterSlug: 'x', anchor: { exact: '' } })]) {
      expect(parseTextPosition(bad as string)).toBeNull()
    }
  })

  it('refuses to emit what the server would refuse to store', () => {
    // The server drops an oversized position (ReaderPosition.MaxLength). Emitting one
    // and letting it silently vanish is worse than not emitting it.
    const huge = buildTextPosition({
      chapterSlug: 'x'.repeat(MAX_SERIALISED_LENGTH), chapterText: CHAPTER, charOffset: 10, chapterFraction: 0.1,
    })
    expect(serializeTextPosition(huge)).toBeNull()
    expect(parseTextPosition('{"v":1,"chapterSlug":"' + 'x'.repeat(MAX_SERIALISED_LENGTH) + '"}')).toBeNull()
  })

  it('coerces a malformed offset instead of trusting it', () => {
    const parsed = parseTextPosition(JSON.stringify({
      ...at(150), charOffset: -5, chapterFraction: 4,
      anchor: { ...at(150).anchor, startOffset: NaN },
    }))
    expect(parsed!.charOffset).toBe(0)
    expect(parsed!.chapterFraction).toBe(1)
    expect(parsed!.anchor.startOffset).toBe(0)
  })
})

describe('resolveTextPosition', () => {
  it('finds the passage in unchanged text', () => {
    const pos = at(150)
    expect(resolveTextPosition(pos, '1-part-one', CHAPTER)).toEqual({ kind: 'anchor', offset: 150 })
  })

  it('survives a font change, because a font change does not touch the text', () => {
    // The whole point, stated as an identity: reflow changes pixels and nothing else.
    const pos = at(150)
    expect(resolveTextPosition(pos, '1-part-one', CHAPTER)).toEqual({ kind: 'anchor', offset: 150 })
  })

  it('survives text being inserted before the passage', () => {
    // A re-parse that recovers a dropped epigraph, or a typography processor adding
    // an em-dash. The pixel offset and the character offset are both wrong now; the
    // anchor is not.
    const shifted = 'A NEWLY RECOVERED EPIGRAPH, PREVIOUSLY DROPPED BY THE PARSER. ' + CHAPTER
    const r = resolveTextPosition(at(150), '1-part-one', shifted)
    expect(r).toEqual({ kind: 'anchor', offset: 150 + 62 })
  })

  it('survives a typo being fixed inside the passage', () => {
    const fixed = CHAPTER.replace('gritty dust', 'gritty dusts')
    const r = resolveTextPosition(at(230), '1-part-one', fixed)
    expect(r?.kind).toBe('anchor')
  })

  it('falls back to the chapter fraction when the text is gone', () => {
    const pos = at(150)
    expect(resolveTextPosition(pos, '1-part-one', 'a completely different chapter entirely'))
      .toEqual({ kind: 'fraction', fraction: pos.chapterFraction })
  })

  it('refuses a position that belongs to another chapter', () => {
    // The substitution this whole exercise is about. A position for chapter two must
    // NOT resolve to a plausible-looking place in chapter one; the caller has a route
    // it can change instead.
    expect(resolveTextPosition(at(150), '2-part-two', CHAPTER)).toBeNull()
    expect(resolveTextPosition(at(150), null, CHAPTER)).toBeNull()
    expect(resolveTextPosition(null, '1-part-one', CHAPTER)).toBeNull()
  })

  it('resolves nothing at all rather than the top, when it knows nothing', () => {
    const pos = { ...at(150), chapterFraction: 0 }
    expect(resolveTextPosition(pos, '1-part-one', 'unrelated text')).toBeNull()
  })
})

describe('a short quote would be ambiguous — this is why the length is what it is', () => {
  it('picks the right occurrence of a repeated passage at full length', () => {
    const repeated = CHAPTER + ' ' + CHAPTER
    const second = buildTextPosition({
      chapterSlug: 'x', chapterText: repeated, charOffset: CHAPTER.length + 1 + 150, chapterFraction: 0.75,
    })!
    const r = resolveTextPosition(second, 'x', repeated)
    expect(r).toEqual({ kind: 'anchor', offset: CHAPTER.length + 1 + 150 })
  })

  it('uses the offset hint only to choose between candidates, never to invent one', () => {
    // The tie-break must not override the resolver. Text that no longer contains the
    // passage falls to the fraction, even though charOffset still points somewhere.
    const pos = at(150)
    expect(resolveTextPosition(pos, '1-part-one', 'a completely different chapter entirely'))
      .toEqual({ kind: 'fraction', fraction: pos.chapterFraction })
  })

  it('would not, at four characters', () => {
    // Kept as the argument for POSITION_QUOTE_LENGTH. With a four-character quote the
    // context ladder has almost nothing to weigh and lands on the first occurrence.
    const repeated = CHAPTER + ' ' + CHAPTER
    const wrong = resolveTextPosition(
      { v: 1, chapterSlug: 'x', charOffset: 0, chapterFraction: 0.75,
        anchor: { prefix: '', exact: 'the ', suffix: '', startOffset: 0, endOffset: 4 } },
      'x', repeated)
    expect(wrong).toEqual({ kind: 'anchor', offset: repeated.indexOf('the ') })
  })
})
