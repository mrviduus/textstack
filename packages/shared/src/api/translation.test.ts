import { describe, expect, it } from 'vitest'
import { translateBody, translateCacheKey } from './translation'

describe('translateBody', () => {
  it('TR-1: a tapped word sends its sentence and bookId', () => {
    expect(translateBody('pocketed', 'en', 'pt', { sentence: ' He pocketed the coins. ', bookId: 'b1' }))
      .toEqual({ text: 'pocketed', sourceLang: 'en', targetLang: 'pt', sentence: 'He pocketed the coins.', bookId: 'b1' })
  })

  it('TR-1: a short selection (<= 3 words, <= 40 chars) sends its sentence', () => {
    expect(translateBody('pocketed the coins', 'en', 'pt', { sentence: 'He pocketed the coins.' }).sentence)
      .toBe('He pocketed the coins.')
  })

  it('TR-1: a passage, a long spaceless run, or the sentence itself sends no sentence', () => {
    const s = 'He pocketed the coins and left.'
    expect(translateBody('He pocketed the coins', 'en', 'pt', { sentence: s }).sentence).toBeUndefined()
    expect(translateBody('a'.repeat(41), 'ja', 'en', { sentence: 'a'.repeat(41) + 'b' }).sentence).toBeUndefined()
    expect(translateBody(s, 'en', 'pt', { sentence: s }).sentence).toBeUndefined()
  })

  it('TR-1: no context sends only text and languages', () => {
    expect(translateBody('hello', 'en', 'uk', { sentence: '  ', bookId: null }))
      .toEqual({ text: 'hello', sourceLang: 'en', targetLang: 'uk' })
  })
})

describe('translateCacheKey', () => {
  it('TR-1: key includes the sentence as sent and keeps the text case', () => {
    const k = (text: string, sentence?: string) => translateCacheKey(text, 'en', 'pt', { sentence })
    expect(k('wound', 'The wound bled.')).not.toBe(k('wound', 'Later she wound the clock.'))
    expect(k('wound', ' The wound bled. ')).toBe(k('wound', 'The wound bled.'))
    expect(k('US')).not.toBe(k('us'))
    // A passage is sent without its sentence, so the sentence is not in its key.
    expect(k('He pocketed the coins and', 'He pocketed the coins and left.')).toBe(k('He pocketed the coins and'))
  })

  it('TR-1: the body sends the text trimmed exactly as the key keys it', () => {
    const body = translateBody(' wound\n', 'en', 'pt', { sentence: 'Later she wound the clock.' })
    expect(body.text).toBe('wound')
    expect(JSON.parse(translateCacheKey(' wound\n', 'en', 'pt', { sentence: 'Later she wound the clock.' }))[2])
      .toBe(body.text)
  })
})
