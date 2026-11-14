import { describe, expect, it, vi } from 'vitest'
import { backfillTranslations } from './vocabWords.mjs'

// #1271: the backfill rule both hosts run (serial writes, a 429 stops it, cancelled by a newer load or the host gone).
const w = (id: string, word: string) => ({ id, word })

describe('backfillTranslations', () => {
  const base = () => ({
    translate: vi.fn(async (word: string): Promise<string | null> => `uk:${word}`),
    persist: vi.fn(async (_id: string, _t: string): Promise<unknown> => undefined),
    onWord: vi.fn((_id: string, _t: string) => {}),
    cancelled: () => false,
  })
  const io = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over })

  it('each word given: translated, handed over and stored on its card', async () => {
    const x = io()
    await backfillTranslations([w('1', 'pond')], 'en', 'uk', x)
    expect(x.translate.mock.calls).toEqual([['pond']])
    expect(x.onWord.mock.calls).toEqual([['1', 'uk:pond']])
    expect(x.persist.mock.calls).toEqual([['1', 'uk:pond']])
  })

  it('no other language (none, the book\'s none, or the book is the reader\'s): nothing', async () => {
    const x = io()
    await backfillTranslations([w('1', 'pond')], 'en', 'en', x)
    await backfillTranslations([w('1', 'pond')], 'en', null, x)
    await backfillTranslations([w('1', 'pond')], null, 'uk', x)
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

