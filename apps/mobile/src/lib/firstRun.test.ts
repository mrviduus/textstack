import { describe, it, expect } from 'vitest'
import {
  decideStartReadingCard,
  decideReaderExitPrompt,
  latchChapterEnd,
  shouldInterceptReaderBack,
  READ_SOMETHING_MIN_FRACTION,
  CHAPTER_END_PROGRESS,
  OWN_BOOK_ASK_SEEN_KEY,
  type ReaderExitInput,
} from './firstRun'
import { DEMO_BOOK, demoBookRoute } from './demoBook'

describe('decideStartReadingCard', () => {
  it('shows the card to a device that has read nothing', () => {
    expect(decideStartReadingCard({ loaded: true, progressFractions: [] })).toEqual({ show: true })
  })

  it('shows nothing until storage has answered', () => {
    // The failure this guards: the card flashing in on top of Discover and
    // then disappearing for a reader with a shelf full of books.
    expect(decideStartReadingCard({ loaded: false, progressFractions: [] }))
      .toEqual({ show: false, reason: 'unknown' })
    expect(decideStartReadingCard({ loaded: false, progressFractions: [0.9] }))
      .toEqual({ show: false, reason: 'unknown' })
  })

  it('hides the card once anything has actually been read', () => {
    expect(decideStartReadingCard({ loaded: true, progressFractions: [0.4] }))
      .toEqual({ show: false, reason: 'already-reading' })
    // Only one row has to have moved.
    expect(decideStartReadingCard({ loaded: true, progressFractions: [0, 0, 0.31] }))
      .toEqual({ show: false, reason: 'already-reading' })
  })

  it('still shows the card when every cached row is a zero-progress open', () => {
    // The reader flushes on unmount whether or not the page moved, so opening
    // a chapter and backing straight out writes a valid row at percent 0.
    // Counting rows instead of reading them would hide the card from exactly
    // the person it is for.
    expect(decideStartReadingCard({ loaded: true, progressFractions: [0, 0, 0] }))
      .toEqual({ show: true })
  })

  it('treats the threshold as inclusive and ignores junk values', () => {
    expect(decideStartReadingCard({ loaded: true, progressFractions: [READ_SOMETHING_MIN_FRACTION] }))
      .toEqual({ show: false, reason: 'already-reading' })
    expect(decideStartReadingCard({ loaded: true, progressFractions: [READ_SOMETHING_MIN_FRACTION - 0.001] }))
      .toEqual({ show: true })
    expect(decideStartReadingCard({ loaded: true, progressFractions: [NaN, Infinity] }))
      .toEqual({ show: true })
  })
})

describe('latchChapterEnd', () => {
  const ev = (o: Partial<Parameters<typeof latchChapterEnd>[1]> = {}) => ({
    chapterProgress: 0,
    visibleChapterSlug: '2-down-the-rabbit-hole',
    openedChapterSlug: '2-down-the-rabbit-hole',
    ...o,
  })

  it('is false while the reader is still inside the chapter it opened', () => {
    expect(latchChapterEnd(false, ev({ chapterProgress: 0.5 }))).toBe(false)
  })

  it('trips at the end-of-chapter threshold', () => {
    expect(latchChapterEnd(false, ev({ chapterProgress: CHAPTER_END_PROGRESS }))).toBe(true)
    expect(latchChapterEnd(false, ev({ chapterProgress: CHAPTER_END_PROGRESS - 0.01 }))).toBe(false)
  })

  it('trips when infinite scroll has carried the reader into another chapter', () => {
    // Crossing the boundary resets the within-chapter fraction to ~0, so the
    // fraction alone would say "just started" at the exact moment a chapter
    // was finished.
    expect(latchChapterEnd(false, ev({ chapterProgress: 0.02, visibleChapterSlug: '3-the-pool-of-tears' })))
      .toBe(true)
  })

  it('does not trip on a null visible slug', () => {
    // No progress message has named a chapter yet — that is not evidence of
    // having crossed one.
    expect(latchChapterEnd(false, ev({ visibleChapterSlug: null }))).toBe(false)
  })

  it('is monotonic — scrolling back up does not un-finish the chapter', () => {
    expect(latchChapterEnd(true, ev({ chapterProgress: 0.1 }))).toBe(true)
  })

  it('ignores a non-finite fraction', () => {
    expect(latchChapterEnd(false, ev({ chapterProgress: NaN }))).toBe(false)
  })
})

describe('decideReaderExitPrompt', () => {
  const input = (o: Partial<ReaderExitInput> = {}): ReaderExitInput => ({
    sessionWordCount: 3,
    sourceKind: 'edition',
    finishedChapter: true,
    ownBookAskSeen: false,
    ...o,
  })

  it('asks for their own book at the end of a chapter they saved words in', () => {
    expect(decideReaderExitPrompt(input())).toBe('own-book')
  })

  it('says nothing when no word was saved — the ask is earned by the mechanic', () => {
    expect(decideReaderExitPrompt(input({ sessionWordCount: 0 }))).toBe('none')
    // Even at the end of the chapter, and even if we have never asked.
    expect(decideReaderExitPrompt(input({ sessionWordCount: 0, finishedChapter: true }))).toBe('none')
  })

  it('never asks someone who is already reading a book of their own', () => {
    expect(decideReaderExitPrompt(input({ sourceKind: 'userbook' }))).toBe('review-words')
  })

  it('asks once per install', () => {
    expect(decideReaderExitPrompt(input({ ownBookAskSeen: true }))).toBe('review-words')
  })

  it('falls back to the vocabulary summary when they bailed mid-chapter', () => {
    expect(decideReaderExitPrompt(input({ finishedChapter: false }))).toBe('review-words')
  })

  it('keeps the existing summary intact for every non-ask session', () => {
    // The regression this pins: the ask must never swallow the vocabulary
    // funnel for sessions it does not apply to.
    expect(decideReaderExitPrompt(input({ sessionWordCount: 1, finishedChapter: false }))).toBe('review-words')
    expect(decideReaderExitPrompt(input({ sourceKind: 'userbook', ownBookAskSeen: true }))).toBe('review-words')
  })
})

describe('shouldInterceptReaderBack', () => {
  const back = (o: Partial<Parameters<typeof shouldInterceptReaderBack>[0]> = {}) =>
    shouldInterceptReaderBack({ promptVisible: false, otherOverlayOpen: false, prompt: 'own-book', ...o })

  it('swallows the first back press only when the ask is about to be shown', () => {
    expect(back()).toBe(true)
  })

  it('leaves normal exits alone', () => {
    expect(back({ prompt: 'none' })).toBe(false)
    // Not widened to the pre-existing summary: back has always popped past it.
    expect(back({ prompt: 'review-words' })).toBe(false)
  })

  it('never traps the reader — the second press always leaves', () => {
    expect(back({ promptVisible: true })).toBe(false)
  })

  it('does not steal a press that belongs to an open sheet', () => {
    expect(back({ otherOverlayOpen: true })).toBe(false)
  })
})

describe('demo book', () => {
  it('points at the first prose chapter, matching web', () => {
    // Chapter 0 of this edition is Carroll's dedicatory poem; the reader we
    // hand a stranger has to be prose. Slugs verified against production.
    expect(DEMO_BOOK.bookSlug).toBe('alices-adventures-in-wonderland')
    expect(DEMO_BOOK.chapterSlug).toBe('2-down-the-rabbit-hole')
  })

  it('builds the singular /reader/{book}/{chapter} route', () => {
    // `/books/...` is the list screen; `/reader/...` is `app/reader/[bookSlug]/[chapterSlug].tsx`.
    expect(demoBookRoute()).toBe('/reader/alices-adventures-in-wonderland/2-down-the-rabbit-hole')
  })
})

describe('storage keys', () => {
  it('follows the onboarding.* convention already on disk', () => {
    expect(OWN_BOOK_ASK_SEEN_KEY).toBe('onboarding.ownBookAsk.seen')
  })
})
