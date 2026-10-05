import { describe, it, expect } from 'vitest'
import { buildUserBookProgressPayload, parseScrollLocator } from './progressPayload'

describe('buildUserBookProgressPayload — slug resolution', () => {
  it('prefers currentChapterSlug over fallback', () => {
    const p = buildUserBookProgressPayload({
      currentChapterSlug: 'live-slug',
      fallbackChapterSlug: 'url-slug',
      chapterProgress: 0.5,
      scrollOffset: 1000,
    })
    expect(p?.chapterSlug).toBe('live-slug')
    expect(p?.locator).toBe('scroll:live-slug:1000')
  })

  it('falls back to URL slug when currentChapterSlug is null', () => {
    const p = buildUserBookProgressPayload({
      currentChapterSlug: null,
      fallbackChapterSlug: 'url-slug',
      chapterProgress: 0.5,
      scrollOffset: 0,
    })
    expect(p?.chapterSlug).toBe('url-slug')
  })

  it('falls back to URL slug when currentChapterSlug is empty string', () => {
    const p = buildUserBookProgressPayload({
      currentChapterSlug: '',
      fallbackChapterSlug: 'url-slug',
      chapterProgress: 0,
      scrollOffset: 0,
    })
    expect(p?.chapterSlug).toBe('url-slug')
  })

  it('returns null when both slugs missing', () => {
    expect(buildUserBookProgressPayload({
      currentChapterSlug: null,
      fallbackChapterSlug: null,
      chapterProgress: 0.5,
      scrollOffset: 100,
    })).toBeNull()
  })

  it('returns null when both slugs are empty strings', () => {
    expect(buildUserBookProgressPayload({
      currentChapterSlug: '',
      fallbackChapterSlug: '',
      chapterProgress: 0.5,
      scrollOffset: 100,
    })).toBeNull()
  })

  it('returns null when slugs are undefined', () => {
    expect(buildUserBookProgressPayload({
      currentChapterSlug: undefined,
      fallbackChapterSlug: undefined,
      chapterProgress: 0,
      scrollOffset: 0,
    })).toBeNull()
  })
})

describe('buildUserBookProgressPayload — percent clamping', () => {
  // A single-chapter book, so the book-wide percent equals the chapter fraction
  // and the clamping is what these cases actually exercise. They used to pass
  // no chapters at all, which exercised a fallback that wrote the chapter
  // fraction into a column declared book-wide.
  const base = {
    currentChapterSlug: 's',
    fallbackChapterSlug: null,
    scrollOffset: 0,
    chapters: [{ slug: 's', wordCount: 1000 }],
  }

  it('passes through valid 0..1 progress', () => {
    expect(buildUserBookProgressPayload({ ...base, chapterProgress: 0.42 })?.percent).toBe(0.42)
  })

  it('clamps progress > 1 to 1', () => {
    expect(buildUserBookProgressPayload({ ...base, chapterProgress: 1.5 })?.percent).toBe(1)
  })

  it('clamps negative progress to 0', () => {
    expect(buildUserBookProgressPayload({ ...base, chapterProgress: -0.5 })?.percent).toBe(0)
  })

  it('coerces NaN to 0', () => {
    expect(buildUserBookProgressPayload({ ...base, chapterProgress: NaN })?.percent).toBe(0)
  })

  it('coerces Infinity to 0', () => {
    expect(buildUserBookProgressPayload({ ...base, chapterProgress: Infinity })?.percent).toBe(0)
  })

  it('coerces -Infinity to 0', () => {
    expect(buildUserBookProgressPayload({ ...base, chapterProgress: -Infinity })?.percent).toBe(0)
  })
})

describe('buildUserBookProgressPayload — book-wide percent (Fix D)', () => {
  // 10 equal chapters; halfway through chapter 2 (idx 1).
  const chapters = Array.from({ length: 10 }, (_, i) => ({ slug: `ch${i + 1}`, wordCount: 100 }))

  it('stores book-wide percent when chapters are supplied (not raw chapter %)', () => {
    // (100 words before + 100 * 0.5) / 1000 = 0.15, NOT the raw 0.5.
    const p = buildUserBookProgressPayload({
      currentChapterSlug: 'ch2',
      fallbackChapterSlug: null,
      chapterProgress: 0.5,
      scrollOffset: 0,
      chapters,
    })
    expect(p?.percent).toBeCloseTo(0.15, 5)
  })

  it('uses totalWordCount as the denominator when provided', () => {
    // Same numerator (150) over an explicit 3000-word book → 0.05.
    const p = buildUserBookProgressPayload({
      currentChapterSlug: 'ch2',
      fallbackChapterSlug: null,
      chapterProgress: 0.5,
      scrollOffset: 0,
      chapters,
      totalWordCount: 3000,
    })
    expect(p?.percent).toBeCloseTo(0.05, 5)
  })

  it('omits the percent when the chapter cannot be located — never the raw chapter %', () => {
    // This used to fall back to the chapter fraction, which reaches 1.0 at the
    // bottom of every chapter and is exactly what this column was canonicalised
    // to stop storing. Omitting it makes the server keep the last known good
    // value; the position is still saved via the locator.
    const p = buildUserBookProgressPayload({
      currentChapterSlug: 'unknown',
      fallbackChapterSlug: null,
      chapterProgress: 0.42,
      scrollOffset: 900,
      chapters,
    })
    expect(p?.percent).toBeUndefined()
    expect(p?.locator).toBe('scroll:unknown:900')
  })

  it('omits the percent when there is no chapter list at all', () => {
    // Every save made offline: the list never resolves.
    const p = buildUserBookProgressPayload({
      currentChapterSlug: 'ch2',
      fallbackChapterSlug: null,
      chapterProgress: 0.5,
      scrollOffset: 10,
    })
    expect(p?.percent).toBeUndefined()
    expect(p?.chapterSlug).toBe('ch2')
  })

  it('keeps the within-chapter locator regardless of book-wide percent', () => {
    const p = buildUserBookProgressPayload({
      currentChapterSlug: 'ch2',
      fallbackChapterSlug: null,
      chapterProgress: 0.5,
      scrollOffset: 1234,
      chapters,
    })
    expect(p?.locator).toBe('scroll:ch2:1234')
    expect(p?.chapterSlug).toBe('ch2')
  })
})

describe('buildUserBookProgressPayload — locator', () => {
  const base = { currentChapterSlug: 'ch1', fallbackChapterSlug: null, chapterProgress: 0.5 }

  it('formats locator as scroll:<slug>:<offset>', () => {
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: 2500 })?.locator).toBe('scroll:ch1:2500')
  })

  it('rounds fractional offsets', () => {
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: 2500.7 })?.locator).toBe('scroll:ch1:2501')
  })

  it('coerces negative offset to 0', () => {
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: -50 })?.locator).toBe('scroll:ch1:0')
  })

  it('coerces NaN offset to 0', () => {
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: NaN })?.locator).toBe('scroll:ch1:0')
  })

  it('coerces Infinity offset to 0', () => {
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: Infinity })?.locator).toBe('scroll:ch1:0')
  })

  it('encodes slug verbatim — no escaping (server is forgiving)', () => {
    const p = buildUserBookProgressPayload({
      currentChapterSlug: 'part-1_chapter-2.subsection',
      fallbackChapterSlug: null,
      chapterProgress: 0,
      scrollOffset: 0,
    })
    expect(p?.locator).toBe('scroll:part-1_chapter-2.subsection:0')
  })
})

describe('buildUserBookProgressPayload — full payload shape', () => {
  it('returns all required wire fields', () => {
    const p = buildUserBookProgressPayload({
      currentChapterSlug: 'ch5',
      fallbackChapterSlug: 'ch4',
      chapterProgress: 0.73,
      scrollOffset: 4200,
      chapters: [{ slug: 'ch5', wordCount: 1000 }],
    })
    expect(p).toEqual({
      percent: 0.73,
      percentUnit: 'book',
      chapterSlug: 'ch5',
      locator: 'scroll:ch5:4200',
      locatorKind: 'scroll',
    })
  })

  it('declares the unit whenever it sends a percent, and never without one', () => {
    // The server stores a percentage only when it knows what it is a fraction of,
    // so a payload carrying a number without its unit would silently stop being
    // saved — and a unit without a number would be a claim about nothing.
    const withPercent = buildUserBookProgressPayload({
      currentChapterSlug: 'ch5',
      fallbackChapterSlug: null,
      chapterProgress: 0.5,
      scrollOffset: null,
      chapters: [{ slug: 'ch5', wordCount: 1000 }],
    })
    expect(withPercent?.percent).toBeDefined()
    expect(withPercent?.percentUnit).toBe('book')

    // No chapter list — the book fraction cannot be computed, so neither travels
    // and the server keeps its last known good value.
    const withoutPercent = buildUserBookProgressPayload({
      currentChapterSlug: 'ch5',
      fallbackChapterSlug: null,
      chapterProgress: 0.5,
      scrollOffset: null,
    })
    expect(withoutPercent?.percent).toBeUndefined()
    expect(withoutPercent?.percentUnit).toBeUndefined()
  })

  it('still produces a payload at offset zero — that is a real position', () => {
    // Load-bearing. `scroll:<slug>:0` is what a reader who just opened a chapter
    // legitimately has, which is precisely why the server rule cannot detect the
    // corrupting write by looking for degenerate values. It has to know which
    // coordinate space owns the book, and the locator has to say which space it
    // is in. This test exists so nobody "optimises" the zero case away and
    // reintroduces the bug from the other side.
    const p = buildUserBookProgressPayload({
      currentChapterSlug: 'ch1',
      fallbackChapterSlug: null,
      chapterProgress: 0,
      scrollOffset: 0,
      chapters: [{ slug: 'ch1', wordCount: 1000 }],
    })
    expect(p?.locator).toBe('scroll:ch1:0')
    expect(p?.locatorKind).toBe('scroll')
  })
})

describe('buildUserBookProgressPayload — runtime JSON-boundary defense', () => {
  // The WebView postMessage path is untyped at runtime. TypeScript can't
  // see through it; these tests guard against the real failure modes.
  const base = { currentChapterSlug: 'ch1', fallbackChapterSlug: null, chapterProgress: 0.5 }

  it('null scrollOffset → 0', () => {
    // Cast through unknown: simulating a JSON parse that produced null.
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: null as unknown as number })?.locator)
      .toBe('scroll:ch1:0')
  })

  it('undefined scrollOffset → 0', () => {
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: undefined as unknown as number })?.locator)
      .toBe('scroll:ch1:0')
  })

  it('string scrollOffset → 0', () => {
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: '500' as unknown as number })?.locator)
      .toBe('scroll:ch1:0')
  })

  it('object scrollOffset → 0', () => {
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: {} as unknown as number })?.locator)
      .toBe('scroll:ch1:0')
  })

  it('caps absurdly large offset at MAX_SCROLL_OFFSET', () => {
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: 1e20 })?.locator)
      .toBe('scroll:ch1:10000000')
  })

  it('caps at boundary exactly', () => {
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: 10_000_001 })?.locator)
      .toBe('scroll:ch1:10000000')
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: 10_000_000 })?.locator)
      .toBe('scroll:ch1:10000000')
  })

  it('passes through realistic long-form offset (300k px)', () => {
    expect(buildUserBookProgressPayload({ ...base, scrollOffset: 300_000 })?.locator)
      .toBe('scroll:ch1:300000')
  })

  it('non-string slug currentChapterSlug treated as falsy → falls back', () => {
    // Defends against WebView accidentally sending {chapterSlug: 0} etc.
    expect(buildUserBookProgressPayload({
      currentChapterSlug: 0 as unknown as string,
      fallbackChapterSlug: 'url-slug',
      chapterProgress: 0,
      scrollOffset: 0,
    })?.chapterSlug).toBe('url-slug')
  })
})

describe('parseScrollLocator — happy path', () => {
  it('parses simple scroll:slug:offset', () => {
    expect(parseScrollLocator('scroll:chapter-1:1500')).toEqual({ slug: 'chapter-1', offset: 1500 })
  })

  it('parses zero offset (top of chapter)', () => {
    expect(parseScrollLocator('scroll:ch1:0')).toEqual({ slug: 'ch1', offset: 0 })
  })

  it('parses large offset (long-form content)', () => {
    expect(parseScrollLocator('scroll:ch1:299000')).toEqual({ slug: 'ch1', offset: 299000 })
  })

  it('round-trips through buildUserBookProgressPayload', () => {
    const p = buildUserBookProgressPayload({
      currentChapterSlug: 'part-1-chapter-2',
      fallbackChapterSlug: null,
      chapterProgress: 0.5,
      scrollOffset: 4200,
    })
    expect(parseScrollLocator(p!.locator)).toEqual({ slug: 'part-1-chapter-2', offset: 4200 })
  })
})

describe('parseScrollLocator — slug with colons (multi-colon defense)', () => {
  // This is the real defense — naive split(':') would break here. The
  // previous inline parsers in both readers would have lost slug data
  // and corrupted the offset on a slug like "chapter-1: introduction"
  // (rare but possible from user-uploaded EPUBs with weird titles).
  it('handles single colon in slug', () => {
    expect(parseScrollLocator('scroll:chapter-1:intro:500')).toEqual({
      slug: 'chapter-1:intro',
      offset: 500,
    })
  })

  it('handles multiple colons in slug', () => {
    expect(parseScrollLocator('scroll:a:b:c:d:42')).toEqual({
      slug: 'a:b:c:d',
      offset: 42,
    })
  })

  it('round-trips a colon-containing slug via build → parse', () => {
    const p = buildUserBookProgressPayload({
      currentChapterSlug: 'odd:slug:name',
      fallbackChapterSlug: null,
      chapterProgress: 0,
      scrollOffset: 100,
    })
    expect(parseScrollLocator(p!.locator)).toEqual({ slug: 'odd:slug:name', offset: 100 })
  })
})

describe('parseScrollLocator — malformed inputs', () => {
  it('returns null for null', () => {
    expect(parseScrollLocator(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(parseScrollLocator(undefined)).toBeNull()
  })

  it('returns null for non-string', () => {
    expect(parseScrollLocator(123 as unknown as string)).toBeNull()
    expect(parseScrollLocator({} as unknown as string)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseScrollLocator('')).toBeNull()
  })

  it('returns null for wrong prefix', () => {
    expect(parseScrollLocator('jump:ch1:100')).toBeNull()
    expect(parseScrollLocator('SCROLL:ch1:100')).toBeNull() // case-sensitive
  })

  it('returns null for prefix alone (no slug or offset)', () => {
    expect(parseScrollLocator('scroll:')).toBeNull()
  })

  it('returns null for missing offset segment', () => {
    expect(parseScrollLocator('scroll:ch1')).toBeNull()
  })

  it('returns null for empty offset string', () => {
    expect(parseScrollLocator('scroll:ch1:')).toBeNull()
  })

  it('returns null for negative offset', () => {
    expect(parseScrollLocator('scroll:ch1:-50')).toBeNull()
  })

  it('returns null for non-integer offset', () => {
    expect(parseScrollLocator('scroll:ch1:12.5')).toBeNull()
    expect(parseScrollLocator('scroll:ch1:abc')).toBeNull()
    expect(parseScrollLocator('scroll:ch1:123abc')).toBeNull() // parseInt would lenient-parse this
  })

  it('returns null for empty slug', () => {
    expect(parseScrollLocator('scroll::500')).toBeNull()
  })
})

describe('buildUserBookProgressPayload — client stamp', () => {
  const base = { currentChapterSlug: 'ch-1', fallbackChapterSlug: null, chapterProgress: 0.5, scrollOffset: 10 }

  it('sends recordedAt as updatedAt so the server can order writes on the client clock', () => {
    const at = Date.parse('2026-05-01T10:00:00Z')
    expect(buildUserBookProgressPayload({ ...base, recordedAt: at })?.updatedAt).toBe('2026-05-01T10:00:00.000Z')
  })

  it('omits updatedAt when no usable stamp is given', () => {
    expect(buildUserBookProgressPayload(base)).not.toHaveProperty('updatedAt')
    expect(buildUserBookProgressPayload({ ...base, recordedAt: Number.NaN })).not.toHaveProperty('updatedAt')
  })
})
