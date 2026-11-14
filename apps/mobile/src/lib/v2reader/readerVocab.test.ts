import { describe, expect, it, vi } from 'vitest'
import { backfillTranslations, forBook, mergeWords, nudgeCount, withSaved, withTranslation, type ReaderWord } from './readerVocab'

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
  it('the rows are the truth: a word no row has any more is gone (a tombstone, an adoption, a wipe)', () => {
    expect(mergeWords([w('1', 'pond')], [], new Map()).words).toEqual([w('1', 'pond')])
  })
  it('a save no row has yet is kept after the rows; one a row has is done; a filled translation stays on its row', () => {
    const saves = [w('9', 'otter'), w('8', 'Reed')]
    const { words, saves: owed } = mergeWords([w('2', 'reed', 1), w('3', 'heron')], saves, new Map([['3', 'чапля']]))
    expect(words).toEqual([w('2', 'reed', 1), w('3', 'heron', 0, 'чапля'), w('9', 'otter')])
    expect(owed).toEqual([w('9', 'otter')])
  })
  it('a save of the same word in another language is still owed', () => {
    expect(mergeWords([w('1', 'die', 0, null, 'de')], [w('2', 'die', 0, null, 'en')], new Map()).saves).toEqual([w('2', 'die', 0, null, 'en')])
  })
})

describe('forBook', () => {
  it('the book\'s language only, by primary subtag; a word of no known language passes', () => {
    const words = [w('1', 'pond', 0, null, 'en-GB'), w('2', 'hund', 0, null, 'de'), w('3', 'x', 0, null, null)]
    expect(forBook(words, 'en').map((x) => x.id)).toEqual(['1', '3'])
    expect(forBook(words, null)).toEqual([])
  })
})

describe('backfillTranslations', () => {
  const base = () => ({
    translate: vi.fn(async (word: string): Promise<string | null> => `uk:${word}`),
    persist: vi.fn(async (_id: string, _t: string): Promise<unknown> => undefined),
    onWord: vi.fn((_id: string, _t: string) => {}),
    cancelled: () => false,
  })
  const io = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over })

  it('each word of the book\'s language without a translation: translated, handed over and stored on its card', async () => {
    const x = io()
    await backfillTranslations([w('1', 'pond'), w('2', 'reed', 0, 'has'), w('3', 'hund', 0, null, 'de')], 'en', 'uk', x)
    expect(x.translate.mock.calls).toEqual([['pond']])
    expect(x.onWord.mock.calls).toEqual([['1', 'uk:pond']])
    expect(x.persist.mock.calls).toEqual([['1', 'uk:pond']])
  })

  it('a card of another language is never written', async () => {
    const x = io()
    await backfillTranslations([w('3', 'hund', 0, null, 'de')], 'en', 'uk', x)
    expect(x.persist).not.toHaveBeenCalled()
  })

  it('no other language (none, or the book is the reader\'s): nothing', async () => {
    const x = io()
    await backfillTranslations([w('1', 'pond')], 'en', 'en', x)
    await backfillTranslations([w('1', 'pond')], 'en', null, x)
    expect(x.translate).not.toHaveBeenCalled()
  })

  it('a failed or empty translation is skipped, the rest go on; a failed store is ignored', async () => {
    const x = io({
      translate: vi.fn(async (word: string): Promise<string | null> => { if (word === 'a') throw new Error('offline'); return word === 'b' ? null : `uk:${word}` }),
      persist: vi.fn(async (_id: string, _t: string): Promise<unknown> => { throw new Error('409') }),
    })
    await backfillTranslations([w('1', 'a'), w('2', 'b'), w('3', 'c'), w('4', 'd')], 'en', 'uk', x)
    expect(x.onWord.mock.calls).toEqual([['3', 'uk:c'], ['4', 'uk:d']])
  })

  it('one write at a time: the next word waits for the card before it', async () => {
    let open = 0
    let most = 0
    const x = io({ persist: vi.fn(async (_id: string, _t: string): Promise<unknown> => { most = Math.max(most, ++open); await new Promise((r) => setTimeout(r, 5)); open--; return undefined }) })
    await backfillTranslations([w('1', 'a'), w('2', 'b'), w('3', 'c')], 'en', 'uk', x)
    expect(x.persist).toHaveBeenCalledTimes(3)
    expect(most).toBe(1)
  })

  it('a 429 on a write or a translation stops it', async () => {
    const tooMany = Object.assign(new Error('429'), { status: 429 })
    const x = io({ persist: vi.fn(async (_id: string, _t: string): Promise<unknown> => { throw tooMany }) })
    await backfillTranslations([w('1', 'a'), w('2', 'b')], 'en', 'uk', x)
    expect(x.translate).toHaveBeenCalledTimes(1)
    const y = io({ translate: vi.fn(async (_w: string): Promise<string | null> => { throw tooMany }) })
    await backfillTranslations([w('1', 'a'), w('2', 'b')], 'en', 'uk', y)
    expect(y.translate).toHaveBeenCalledTimes(1)
  })

  it('cancelled (a new open, the screen gone) stops it: nothing more lands', async () => {
    let stop = false
    const x = io({ translate: vi.fn(async (word: string): Promise<string | null> => { stop = true; return `uk:${word}` }), cancelled: () => stop })
    await backfillTranslations([w('1', 'a'), w('2', 'b')], 'en', 'uk', x)
    expect(x.translate).toHaveBeenCalledTimes(1)
    expect(x.onWord).not.toHaveBeenCalled()
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
