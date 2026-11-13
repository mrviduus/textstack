import { describe, it, expect } from 'vitest'
import {
  wordsRemaining,
  minutesForWords,
  estimateTimeLeft,
  formatMinutesLeft,
  bookMinutesLeft,
  timeLeftAt,
  placeTimeLeftLabel,
  FALLBACK_WPM,
} from './readingTime'

const ch = (slug: string, wordCount: number | null | undefined) => ({ slug, wordCount })

// A 3-chapter book: 1000 / 2000 / 3000 words.
const book = [ch('one', 1000), ch('two', 2000), ch('three', 3000)]

describe('wordsRemaining', () => {
  it('counts the rest of the current chapter plus every chapter after it', () => {
    // Halfway through chapter two: 1000 left there, 3000 after.
    expect(wordsRemaining(book, 'two', 0.5)).toEqual({ chapter: 1000, book: 4000 })
  })

  it('is the whole book at the very start', () => {
    expect(wordsRemaining(book, 'one', 0)).toEqual({ chapter: 1000, book: 6000 })
  })

  it('is zero at the end of the last chapter', () => {
    expect(wordsRemaining(book, 'three', 1)).toEqual({ chapter: 0, book: 0 })
  })

  it('clamps a progress value outside 0..1 instead of going negative', () => {
    // A stale locator or a WebView rounding artefact must never produce
    // "-400 words left", which would render as a negative time.
    expect(wordsRemaining(book, 'two', 1.4)).toEqual({ chapter: 0, book: 3000 })
    expect(wordsRemaining(book, 'two', -2)).toEqual({ chapter: 2000, book: 5000 })
  })

  it('treats a non-finite progress as the start of the chapter', () => {
    // `scrollTop / (docHeight - windowHeight)` is 0/0 on a short chapter.
    expect(wordsRemaining(book, 'two', NaN)).toEqual({ chapter: 2000, book: 5000 })
  })

  it('returns null when no chapter carries a word count', () => {
    // Some legacy uploads were never measured. Better to show nothing than a
    // confident wrong number.
    expect(wordsRemaining([ch('a', null), ch('b', undefined)], 'a', 0)).toBeNull()
  })

  it('ignores individual chapters with a missing count rather than bailing', () => {
    const mixed = [ch('one', 1000), ch('two', null), ch('three', 3000)]
    expect(wordsRemaining(mixed, 'one', 0)).toEqual({ chapter: 1000, book: 4000 })
  })

  it('returns null for an unknown slug or an empty book', () => {
    expect(wordsRemaining(book, 'nope', 0)).toBeNull()
    expect(wordsRemaining([], 'one', 0)).toBeNull()
    expect(wordsRemaining(book, null, 0)).toBeNull()
  })
})

describe('minutesForWords', () => {
  it('divides by pace and rounds', () => {
    expect(minutesForWords(1500, 150)).toBe(10)
    expect(minutesForWords(1575, 150)).toBe(11)
  })

  it('never returns a negative or non-finite result', () => {
    expect(minutesForWords(-100, 150)).toBe(0)
    expect(minutesForWords(NaN, 150)).toBe(0)
    expect(minutesForWords(0, 150)).toBe(0)
  })

  it('falls back to the default pace on a nonsensical wpm', () => {
    // A zero wpm would be a division by zero and an Infinity on screen.
    expect(minutesForWords(1500, 0)).toBe(minutesForWords(1500, FALLBACK_WPM))
    expect(minutesForWords(1500, -50)).toBe(minutesForWords(1500, FALLBACK_WPM))
    expect(minutesForWords(1500, NaN)).toBe(minutesForWords(1500, FALLBACK_WPM))
  })
})

describe('estimateTimeLeft', () => {
  it('reports chapter and book minutes at the reader pace', () => {
    expect(estimateTimeLeft(book, 'two', 0.5, 200)).toEqual({ chapterMinutes: 5, bookMinutes: 20 })
  })

  it('a faster reader always gets an estimate no larger than a slower one', () => {
    const fast = estimateTimeLeft(book, 'one', 0, 300)!
    const slow = estimateTimeLeft(book, 'one', 0, 100)!
    expect(fast.bookMinutes).toBeLessThan(slow.bookMinutes)
  })

  it('book minutes are never below chapter minutes', () => {
    for (const slug of ['one', 'two', 'three']) {
      for (const p of [0, 0.25, 0.5, 0.99, 1]) {
        const t = estimateTimeLeft(book, slug, p, 150)!
        expect(t.bookMinutes).toBeGreaterThanOrEqual(t.chapterMinutes)
      }
    }
  })

  it('returns null when there is nothing to estimate from', () => {
    expect(estimateTimeLeft([ch('a', null)], 'a', 0)).toBeNull()
  })

  it('uses the fallback pace when none is supplied', () => {
    expect(estimateTimeLeft(book, 'one', 0)).toEqual(estimateTimeLeft(book, 'one', 0, FALLBACK_WPM))
  })
})

describe('formatMinutesLeft', () => {
  const labels = {
    under: 'Less than a minute left',
    minutes: '{minutes} min left',
    hours: '{hours} hr left',
    hoursMinutes: '{hours} hr {minutes} min left',
  }

  it('never shows "0 min left"', () => {
    expect(formatMinutesLeft(0, labels)).toBe('Less than a minute left')
    expect(formatMinutesLeft(0.4, labels)).toBe('Less than a minute left')
  })

  it('shows plain minutes below an hour and a half', () => {
    expect(formatMinutesLeft(1, labels)).toBe('1 min left')
    expect(formatMinutesLeft(89, labels)).toBe('89 min left')
  })

  it('rounds to hours past 90 minutes, because the estimate is not that precise', () => {
    expect(formatMinutesLeft(90, labels)).toBe('1 hr 30 min left')
    expect(formatMinutesLeft(120, labels)).toBe('2 hr left')
    expect(formatMinutesLeft(127, labels)).toBe('2 hr 7 min left')
  })

  it('degrades to the under-a-minute label on a non-finite input', () => {
    expect(formatMinutesLeft(NaN, labels)).toBe('Less than a minute left')
  })
})

describe('bookMinutesLeft', () => {
  it('falls back to 200 wpm — the owner-set rule, same as the server', () => {
    expect(FALLBACK_WPM).toBe(200)
    expect(bookMinutesLeft(4000, null, null)).toBe(20)
    expect(bookMinutesLeft(1000, 0, 0)).toBe(5)
  })

  it('uses the personal pace when present', () => {
    expect(bookMinutesLeft(100_000, 0, 250)).toBe(400)
  })

  it('reduces by progress, clamped to 0..1', () => {
    expect(bookMinutesLeft(10_000, 0.5, 200)).toBe(25)
    expect(bookMinutesLeft(1000, 1, 200)).toBe(0)
    expect(bookMinutesLeft(1000, 1.5, 200)).toBe(0)
  })

  it('null without a word count', () => {
    expect(bookMinutesLeft(null, 0.1, 200)).toBeNull()
    expect(bookMinutesLeft(0, 0, 200)).toBeNull()
  })
})

describe('timeLeftAt', () => {
  // 60,000 words at 200 wpm: the whole book is 300 minutes.
  const at = { fraction: 0.5, sectionEnd: 0.6, totalWords: 60_000, wpm: 200 }

  it('counts the chapter to the section end and the book to its end', () => {
    expect(timeLeftAt(at)).toEqual({ chapterMinutes: 30, bookMinutes: 150 })
  })

  it('is null without a pace: no fallback pace here', () => {
    for (const wpm of [null, undefined, 0, -200, NaN, Infinity]) expect(timeLeftAt({ ...at, wpm })).toBeNull()
  })

  it('is the whole book at fraction zero', () => {
    expect(timeLeftAt({ ...at, fraction: 0 })).toEqual({ chapterMinutes: 180, bookMinutes: 300 })
  })

  it('is zero at the end of the book', () => {
    expect(timeLeftAt({ ...at, fraction: 1, sectionEnd: 1 })).toEqual({ chapterMinutes: 0, bookMinutes: 0 })
  })

  it('is null without a book length', () => {
    for (const totalWords of [null, undefined, 0, -1, NaN]) expect(timeLeftAt({ ...at, totalWords })).toBeNull()
  })

  it('is null without a place in 0..1', () => {
    for (const fraction of [null, undefined, NaN, -0.1, 1.1]) expect(timeLeftAt({ ...at, fraction })).toBeNull()
  })

  it('gives the book alone when the section end is unknown', () => {
    for (const sectionEnd of [null, undefined, NaN, 1.5]) expect(timeLeftAt({ ...at, sectionEnd })).toEqual({ chapterMinutes: null, bookMinutes: 150 })
  })

  it('never goes negative past the section end', () => {
    expect(timeLeftAt({ ...at, fraction: 0.7 })).toEqual({ chapterMinutes: 0, bookMinutes: 90 })
  })

  it('halves the minutes at twice the pace', () => {
    expect(timeLeftAt({ ...at, wpm: 400 })).toEqual({ chapterMinutes: 15, bookMinutes: 75 })
  })
})

describe('placeTimeLeftLabel', () => {
  const strings: Record<string, string> = {
    'reader.timeLeft.under': 'Less than a minute left',
    'reader.timeLeft.minutes': '{minutes} min left',
    'reader.timeLeft.hours': '{hours} hr left',
    'reader.timeLeft.hoursMinutes': '{hours} hr {minutes} min left',
    'reader.timeLeft.inChapter': '{time} in chapter',
    'reader.timeLeft.inBook': '{time} in book',
  }
  const t = (key: string) => strings[key] ?? key

  it('names the chapter, then the book', () => {
    expect(placeTimeLeftLabel({ chapterMinutes: 12, bookMinutes: 180 }, t)).toBe('12 min left in chapter · 3 hr left in book')
  })

  it('is the book alone without a chapter estimate', () => {
    expect(placeTimeLeftLabel({ chapterMinutes: null, bookMinutes: 45 }, t)).toBe('45 min left in book')
  })

  it('keeps a chapter estimate of zero: the last stretch, not a missing one', () => {
    expect(placeTimeLeftLabel({ chapterMinutes: 0, bookMinutes: 45 }, t)).toBe('Less than a minute left in chapter · 45 min left in book')
  })

  it('is null without an estimate', () => {
    expect(placeTimeLeftLabel(null, t)).toBeNull()
  })
})
