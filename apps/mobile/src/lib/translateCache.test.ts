import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `POST /translate` is a paid `gpt-4.1-nano` call on the most frequent action
 * in the product (tap a word). These tests exist because the module used to
 * memoize the RESULT and not the PROMISE: two callers in the same ~1s window
 * both missed the cache and both were billed, while the file's own docblock
 * claimed it "de-dupes the double translate per tap".
 */

const translate = vi.hoisted(() => vi.fn())
// The real key rule (translateCacheKey), a fake network.
vi.mock('@textstack/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@textstack/shared')>()
  return { translationApi: { ...real.translationApi, translate } }
})

/** A promise plus its resolvers, so a test can hold a call open. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/**
 * Fresh module per test. The cache and the in-flight map are module-level
 * singletons on purpose (they are shared across the whole reader), so the only
 * honest way to test a cold start is to re-import.
 */
async function freshModule() {
  vi.resetModules()
  return import('./translateCache')
}

beforeEach(() => {
  translate.mockReset()
})

describe('cachedTranslate', () => {
  it('N concurrent callers for the same word produce exactly ONE network call', async () => {
    const { cachedTranslate } = await freshModule()
    const gate = deferred<{ translatedText: string }>()
    translate.mockReturnValue(gate.promise)

    const callers = [
      cachedTranslate('Wort', 'de', 'en'),
      cachedTranslate('Wort', 'de', 'en'),
      cachedTranslate('Wort', 'de', 'en'),
      cachedTranslate('Wort', 'de', 'en'),
    ]
    gate.resolve({ translatedText: 'word' })

    expect(await Promise.all(callers)).toEqual([
      { translation: 'word', category: undefined },
      { translation: 'word', category: undefined },
      { translation: 'word', category: undefined },
      { translation: 'word', category: undefined },
    ])
    expect(translate).toHaveBeenCalledTimes(1)
  })

  it('hands every joiner the same promise, not a copy', async () => {
    const { cachedTranslate } = await freshModule()
    const gate = deferred<{ translatedText: string }>()
    translate.mockReturnValue(gate.promise)

    const a = cachedTranslate('Haus', 'de', 'en')
    const b = cachedTranslate('Haus', 'de', 'en')
    gate.resolve({ translatedText: 'house' })
    await Promise.all([a, b])

    expect(translate).toHaveBeenCalledTimes(1)
  })

  it('keys the dedupe the same way the cache does — different words still both go out', async () => {
    const { cachedTranslate } = await freshModule()
    translate.mockImplementation(async (text: string) => ({ translatedText: `${text}!` }))

    await Promise.all([
      cachedTranslate('eins', 'de', 'en'),
      cachedTranslate('zwei', 'de', 'en'),
      cachedTranslate('eins', 'de', 'uk'), // same word, different target
    ])

    expect(translate).toHaveBeenCalledTimes(3)
  })

  it('normalises surrounding whitespace, so those join instead of paying', async () => {
    const { cachedTranslate } = await freshModule()
    const gate = deferred<{ translatedText: string }>()
    translate.mockReturnValue(gate.promise)

    const callers = [
      cachedTranslate('Wort', 'de', 'en'),
      cachedTranslate('  Wort ', 'de', 'en'),
    ]
    gate.resolve({ translatedText: 'word' })
    await Promise.all(callers)

    expect(translate).toHaveBeenCalledTimes(1)
  })

  it('carries the backend save-recommendation category through to every joiner', async () => {
    const { cachedTranslate } = await freshModule()
    const gate = deferred<{ translatedText: string; category: string }>()
    translate.mockReturnValue(gate.promise)

    const a = cachedTranslate('Schadenfreude', 'de', 'en')
    const b = cachedTranslate('Schadenfreude', 'de', 'en')
    gate.resolve({ translatedText: 'schadenfreude', category: 'rare' })

    expect(await a).toEqual({ translation: 'schadenfreude', category: 'rare' })
    expect(await b).toEqual({ translation: 'schadenfreude', category: 'rare' })
    expect(translate).toHaveBeenCalledTimes(1)
  })

  it('memoizes the result — a later caller is free', async () => {
    const { cachedTranslate, peekTranslation } = await freshModule()
    translate.mockResolvedValue({ translatedText: 'word' })

    await cachedTranslate('Wort', 'de', 'en')
    await cachedTranslate('Wort', 'de', 'en')

    expect(translate).toHaveBeenCalledTimes(1)
    expect(peekTranslation('Wort', 'de', 'en')).toEqual({ translation: 'word', category: undefined })
  })

  it('releases the slot on REJECT — a leaked slot would wedge translation for the whole process', async () => {
    // The classic version of this bug: evict only in the success path, and one
    // failed translate (offline, or the /translate rate limit) keeps the slot
    // forever. Every later tap on that word would be handed the same stale
    // rejection, and the gloss would never come back until the app restarted.
    const { cachedTranslate } = await freshModule()
    translate.mockRejectedValueOnce(new Error('429'))

    await expect(cachedTranslate('Wort', 'de', 'en')).rejects.toThrow('429')

    translate.mockResolvedValueOnce({ translatedText: 'word' })
    await expect(cachedTranslate('Wort', 'de', 'en')).resolves.toEqual({ translation: 'word', category: undefined })
    expect(translate).toHaveBeenCalledTimes(2)
  })

  it('gives concurrent joiners the SAME rejection, and still only calls once', async () => {
    const { cachedTranslate } = await freshModule()
    const gate = deferred<never>()
    translate.mockReturnValue(gate.promise)

    const a = cachedTranslate('Wort', 'de', 'en')
    const b = cachedTranslate('Wort', 'de', 'en')
    gate.reject(new Error('offline'))

    await expect(a).rejects.toThrow('offline')
    await expect(b).rejects.toThrow('offline')
    expect(translate).toHaveBeenCalledTimes(1)
  })

  it('does not memoize an empty translation, so the next tap retries', async () => {
    const { cachedTranslate, peekTranslation } = await freshModule()
    translate.mockResolvedValue({ translatedText: '' })

    await cachedTranslate('Wort', 'de', 'en')
    expect(peekTranslation('Wort', 'de', 'en')).toBeUndefined()

    translate.mockResolvedValue({ translatedText: 'word' })
    expect(await cachedTranslate('Wort', 'de', 'en')).toEqual({ translation: 'word', category: undefined })
    expect(translate).toHaveBeenCalledTimes(2)
  })

  it('does not leak an in-flight entry per word — a long reading session stays bounded', async () => {
    // Not a memory-size assertion; the observable proxy is that after a word
    // has settled, the very next call for it must be served from `cache`
    // without touching the network, which can only happen if the slot was
    // both released AND evicted.
    const { cachedTranslate } = await freshModule()
    translate.mockImplementation(async (text: string) => ({ translatedText: `${text}-en` }))

    for (const w of ['ein', 'zwei', 'drei']) {
      await Promise.all([cachedTranslate(w, 'de', 'en'), cachedTranslate(w, 'de', 'en')])
    }
    for (const w of ['ein', 'zwei', 'drei']) {
      await cachedTranslate(w, 'de', 'en')
    }

    expect(translate).toHaveBeenCalledTimes(3)
  })

  it('TR-1: the cache is a bounded LRU — the oldest unused entry goes past 500, a recently read one stays', async () => {
    const { cachedTranslate, peekTranslation } = await freshModule()
    translate.mockImplementation(async (text: string) => ({ translatedText: `${text}!` }))

    await cachedTranslate('w0', 'de', 'en')
    await cachedTranslate('w1', 'de', 'en')
    for (let i = 2; i < 500; i++) await cachedTranslate(`w${i}`, 'de', 'en')
    await cachedTranslate('w0', 'de', 'en') // a hit refreshes w0
    await cachedTranslate('w500', 'de', 'en') // 501st entry evicts the least recent: w1

    expect(peekTranslation('w0', 'de', 'en')).toBeDefined()
    expect(peekTranslation('w1', 'de', 'en')).toBeUndefined()
    expect(peekTranslation('w500', 'de', 'en')).toBeDefined()
  })

  it('TR-1: cachedTranslate sends the sentence and keys the cache on it', async () => {
    const { cachedTranslate } = await freshModule()
    translate.mockImplementation(async (_t: string, _f: string, _to: string, _s: unknown, ctx?: { sentence?: string }) =>
      ({ translatedText: ctx?.sentence?.includes('clock') ? 'enrolou' : 'ferida' }))

    expect((await cachedTranslate('wound', 'en', 'pt', { sentence: 'The wound bled.', bookId: 'b1' })).translation).toBe('ferida')
    expect((await cachedTranslate('wound', 'en', 'pt', { sentence: 'Later she wound the clock.', bookId: 'b1' })).translation).toBe('enrolou')
    expect(translate).toHaveBeenCalledWith('wound', 'en', 'pt', undefined, { sentence: 'The wound bled.', bookId: 'b1' })
    expect(translate).toHaveBeenCalledTimes(2)
  })
})
