import { describe, expect, it, vi } from 'vitest'
import { backfillTranslations, withSaved, withTranslation, type ReaderWord } from './readerVocab'

const w = (id: string, word: string, stage = 0, translation: string | null = null): ReaderWord => ({ id, word, stage, translation })

describe('withSaved', () => {
  it('a new word is added', () => {
    expect(withSaved([w('1', 'pond')], w('2', 'reed', 0, 'очерет'))).toEqual([w('1', 'pond'), w('2', 'reed', 0, 'очерет')])
  })
  it('the same key (any case, edge punctuation) is that card, replaced; its translation kept when the answer has none', () => {
    expect(withSaved([w('1', 'Pond', 3, 'ставок')], w('9', 'pond,', 0))).toEqual([w('9', 'pond,', 0, 'ставок')])
  })
})

describe('withTranslation', () => {
  it('fills a word without one; never replaces one', () => {
    expect(withTranslation([w('1', 'pond'), w('2', 'reed', 0, 'x')], '1', 'ставок')).toEqual([w('1', 'pond', 0, 'ставок'), w('2', 'reed', 0, 'x')])
    expect(withTranslation([w('2', 'reed', 0, 'x')], '2', 'y')).toEqual([w('2', 'reed', 0, 'x')])
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

  it('each word without a translation: translated, handed over and stored on its card', async () => {
    const x = io()
    await backfillTranslations([w('1', 'pond'), w('2', 'reed', 0, 'has')], 'en', 'uk', x)
    expect(x.translate.mock.calls).toEqual([['pond']])
    expect(x.onWord.mock.calls).toEqual([['1', 'uk:pond']])
    expect(x.persist.mock.calls).toEqual([['1', 'uk:pond']])
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
    await backfillTranslations([w('1', 'a'), w('2', 'b'), w('3', 'c')], 'en', 'uk', x)
    expect(x.onWord.mock.calls).toEqual([['3', 'uk:c']])
  })

  it('a new open stops it: nothing more lands', async () => {
    let stop = false
    const x = io({ translate: vi.fn(async (word: string): Promise<string | null> => { stop = true; return `uk:${word}` }), cancelled: () => stop })
    await backfillTranslations([w('1', 'a'), w('2', 'b')], 'en', 'uk', x)
    expect(x.translate).toHaveBeenCalledTimes(1)
    expect(x.onWord).not.toHaveBeenCalled()
  })
})
