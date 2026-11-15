import { describe, expect, it, vi } from 'vitest'
import { answerRow, backfillable, forBook, nudgeCount, ownsLibrary, serverTranslation, type ReaderWord } from './readerVocab'

const w = (id: string, word: string, stage = 0, translation: string | null = null, language: string | null = 'en'): ReaderWord => ({ id, word, language, stage, translation })

describe('forBook / backfillable', () => {
  it('the book\'s language only, by primary subtag; a word of no known language is not the book\'s', () => {
    const words = [w('1', 'pond', 0, null, 'en-GB'), w('2', 'hund', 0, null, 'de'), w('3', 'x', 0, null, null)]
    expect(forBook(words, 'en').map((x) => x.id)).toEqual(['1'])
    expect(forBook(words, null)).toEqual([])
  })
  it('the backfill fills the book\'s language\'s words without a translation', () => {
    const words = [w('1', 'pond'), w('2', 'reed', 0, 'x'), w('3', 'hund', 0, null, 'de')]
    expect(backfillable(words, 'en').map((x) => x.id)).toEqual(['1'])
    expect(backfillable(words, null)).toEqual([])
  })
})

describe('answerRow', () => {
  const card = { id: 'c1', word: 'Pond', language: 'en', stage: 1, translation: 'ставок' }
  it('a save\'s answer card is its row, as the pull writes it', () => {
    expect(answerRow(card, 'u1', 'u1', 'en', true)).toEqual({ id: 'c1', word: 'Pond', language: 'en', stage: 1, translation: 'ставок' })
  })
  it('the user changed since the save was asked: nothing (another session\'s answer)', () => {
    expect(answerRow(card, 'u1', 'u2', 'en', true)).toBeNull()
    expect(answerRow(card, 'g1', null, 'en', true)).toBeNull()
  })
  it('a save that went to the legacy API (V2 off): no V2 row; the next V2 pull brings it', () => {
    expect(answerRow(card, 'u1', 'u1', 'en', false)).toBeNull()
  })
  it('no card, or no language to file it under: nothing; a card without one takes the book\'s', () => {
    expect(answerRow(null, 'u1', 'u1', 'en', true)).toBeNull()
    expect(answerRow({ ...card, language: null }, 'u1', 'u1', null, true)).toBeNull()
    expect(answerRow({ ...card, language: null }, 'u1', 'u1', 'en', true)?.language).toBe('en')
  })
})

describe('nudgeCount', () => {
  it('the rows once the feed is pulled; the server\'s list before (V2 off, first pull not in)', async () => {
    const legacy = vi.fn(async () => 7)
    expect(await nudgeCount(async () => true, [w('1', 'a'), w('2', 'b', 0, null, 'de')], legacy)).toBe(2)
    expect(legacy).not.toHaveBeenCalled()
    expect(await nudgeCount(async () => false, [w('1', 'a')], legacy)).toBe(7)
    expect(await nudgeCount(async () => { throw new Error('db') }, [], async () => { throw new Error('offline') })).toBe(0)
  })
})

describe('the write rules (#1271 review)', () => {
  it('a library is read and written by its owner, or anyone while it is nobody\'s; never another identity\'s', () => {
    expect(ownsLibrary('u1', 'u1')).toBe(true)
    expect(ownsLibrary(null, 'g1')).toBe(true)
    expect(ownsLibrary('a1', 'g1')).toBe(false)
    expect(ownsLibrary('a1', null)).toBe(false)
  })
  it('the row takes the translation the server kept (onlyIfEmpty), never the one computed here', () => {
    expect(serverTranslation({ translation: 'теперішній' })).toBe('теперішній')
    expect(serverTranslation({ translation: null })).toBeNull()
    expect(serverTranslation(null)).toBeNull()
  })
  it('the backfill leaves a card whose TR-2 fill is in flight', () => {
    expect(backfillable([w('1', 'pond'), w('2', 'reed')], 'en', new Set(['2'])).map((x) => x.id)).toEqual(['1'])
  })
})
