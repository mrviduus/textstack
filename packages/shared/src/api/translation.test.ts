import { describe, expect, it } from 'vitest'
import { translateBody } from './translation'

describe('translateBody', () => {
  // QA-007: a tapped word went to the server with no sentence, so the model
  // guessed the sense ("pocketed" → "enterrado").
  it('translateBody_WithSentence_IncludesSentenceAndBookId', () => {
    expect(translateBody('pocketed', 'en', 'pt', { sentence: 'He pocketed the coins.', bookId: 'b1' }))
      .toEqual({ text: 'pocketed', sourceLang: 'en', targetLang: 'pt', sentence: 'He pocketed the coins.', bookId: 'b1' })
  })

  it('translateBody_NoContext_OmitsContextFields', () => {
    expect(translateBody('hello', 'en', 'uk')).toEqual({ text: 'hello', sourceLang: 'en', targetLang: 'uk' })
  })

  it('translateBody_BlankSentence_Omitted', () => {
    expect(translateBody('hello', 'en', 'uk', { sentence: '  ', bookId: null })).toEqual({ text: 'hello', sourceLang: 'en', targetLang: 'uk' })
  })
})
