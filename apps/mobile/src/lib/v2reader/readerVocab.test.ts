import { describe, expect, it, vi } from 'vitest'
import { UNSTAMPED, backfillable, forBook, mergeWords, nudgeCount, sessionStep, withSaved, withTranslation, type OwedSave, type ReaderWord } from './readerVocab'

const w = (id: string, word: string, stage = 0, translation: string | null = null, language: string | null = 'en'): ReaderWord => ({ id, word, language, stage, translation })

describe('withSaved', () => {
  it('a new word is added last', () => {
    expect(withSaved([w('1', 'pond')], w('2', 'reed', 0, 'очерет'))).toEqual([w('1', 'pond'), w('2', 'reed', 0, 'очерет')])
  })
  it('the same key (any case, edge punctuation) and language is that card, replaced; its translation kept when the answer has none', () => {
    expect(withSaved([w('1', 'Pond', 3, 'ставок')], w('9', 'pond,', 0))).toEqual([w('9', 'pond,', 0, 'ставок')])
  })
  it('the same word in another language is another card', () => {
    expect(withSaved([w('1', 'die', 0, 'x', 'de')], w('2', 'die', 0, null, 'en'))).toEqual([w('1', 'die', 0, 'x', 'de'), w('2', 'die', 0, null, 'en')])
  })
})

describe('withTranslation', () => {
  it('fills a word without one; never replaces one', () => {
    expect(withTranslation([w('1', 'pond'), w('2', 'reed', 0, 'x')], '1', 'ставок')).toEqual([w('1', 'pond', 0, 'ставок'), w('2', 'reed', 0, 'x')])
    expect(withTranslation([w('2', 'reed', 0, 'x')], '2', 'y')).toEqual([w('2', 'reed', 0, 'x')])
  })
})

describe('mergeWords', () => {
  const owed = (x: ReaderWord, pulls = 3): OwedSave => ({ ...x, pulls })
  it('the rows are the truth: a word no row has any more is gone (a tombstone, an adoption, a wipe)', () => {
    expect(mergeWords([w('1', 'pond')], [], new Map(), null).words).toEqual([w('1', 'pond')])
  })
  it('a save no row has yet is kept after the rows; one a row has is done; a filled translation stays on its row', () => {
    const { words, saves } = mergeWords([w('2', 'reed', 1), w('3', 'heron')], [owed(w('9', 'otter')), owed(w('8', 'Reed'))], new Map([['3', 'чапля']]), null)
    expect(words).toEqual([w('2', 'reed', 1), w('3', 'heron', 0, 'чапля'), w('9', 'otter')])
    expect(saves).toEqual([owed(w('9', 'otter'))])
  })
  it('a save of the same word in another language is still owed', () => {
    expect(mergeWords([w('1', 'die', 0, null, 'de')], [owed(w('2', 'die', 0, null, 'en'))], new Map(), null).saves).toEqual([owed(w('2', 'die', 0, null, 'en'))])
  })
  it('a save missing from a pull read to its end that started after it: deleted before this device pulled it, owed no more', () => {
    // Taken when 3 pulls had started: pull 4 read to its end without it.
    const s = owed(w('9', 'otter'), 3)
    expect(mergeWords([], [s], new Map(), 4).saves).toEqual([])
    expect(mergeWords([], [s], new Map(), 4).words).toEqual([])
    // Pull 3 was already under way at the save: it says nothing about it; nor does no full read.
    expect(mergeWords([], [s], new Map(), 3).saves).toEqual([s])
    expect(mergeWords([], [s], new Map(), null).saves).toEqual([s])
  })
})

describe('backfillable', () => {
  it('the book\'s language\'s words without a translation, never an owed save (its own fill may be in flight)', () => {
    const words = [w('1', 'pond'), w('2', 'reed', 0, 'x'), w('3', 'hund', 0, null, 'de'), w('9', 'otter')]
    expect(backfillable(words, [{ ...w('9', 'otter'), pulls: 1 }], 'en').map((x) => x.id)).toEqual(['1'])
    expect(backfillable(words, [], null)).toEqual([])
  })
})

describe('forBook', () => {
  it('the book\'s language only, by primary subtag; a word of no known language is not the book\'s', () => {
    const words = [w('1', 'pond', 0, null, 'en-GB'), w('2', 'hund', 0, null, 'de'), w('3', 'x', 0, null, null)]
    expect(forBook(words, 'en').map((x) => x.id)).toEqual(['1'])
    expect(forBook(words, null)).toEqual([])
  })
})

describe('nudgeCount', () => {
  it('the words in memory once the feed is pulled; the server\'s list before (V2 off, first pull not in)', async () => {
    const legacy = vi.fn(async () => 7)
    expect(await nudgeCount(async () => true, [w('1', 'a'), w('2', 'b', 0, null, 'de')], legacy)).toBe(2)
    expect(legacy).not.toHaveBeenCalled()
    expect(await nudgeCount(async () => false, [w('1', 'a')], legacy)).toBe(7)
    expect(await nudgeCount(async () => { throw new Error('db') }, [], async () => { throw new Error('offline') })).toBe(0)
  })
})

describe('mergeWords: a save not stamped', () => {
  it('is owed whatever has been read, and stamped by the read with the pulls started by then', () => {
    const s: OwedSave = { ...w('9', 'otter'), pulls: UNSTAMPED }
    const first = mergeWords([], [s], new Map(), 7, 7)
    expect(first.saves).toEqual([{ ...s, pulls: 7 }])
    // Then a later full read without it expires it.
    expect(mergeWords([], first.saves, new Map(), 8, 8).saves).toEqual([])
  })
})

describe('sessionStep', () => {
  it('a guest becoming an account keeps the session\'s words; a sign-out, another account or guest clears them', () => {
    expect(sessionStep({ id: 'g1', guest: true }, { id: 'a1', guest: false })).toBe('keep')
    expect(sessionStep({ id: 'a1', guest: false }, { id: 'a1', guest: false })).toBe('same')
    expect(sessionStep({ id: 'a1', guest: false }, { id: null, guest: false })).toBe('clear')
    expect(sessionStep({ id: 'a1', guest: false }, { id: 'a2', guest: false })).toBe('clear')
    expect(sessionStep({ id: 'g1', guest: true }, { id: 'g2', guest: true })).toBe('clear')
    expect(sessionStep({ id: 'g1', guest: true }, { id: null, guest: false })).toBe('clear')
  })
})
