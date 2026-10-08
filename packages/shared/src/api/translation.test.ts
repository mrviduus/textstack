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

  // Review of #780: a passage carries its own context — the sentence is only for a word
  // or a short phrase (<= 3 words) inside it.
  it('translateBody_ShortPhrase_IncludesSentence', () => {
    expect(translateBody('pocketed the coins', 'en', 'pt', { sentence: 'He pocketed the coins.' }).sentence)
      .toBe('He pocketed the coins.')
  })

  it('translateBody_Passage_OmitsSentence', () => {
    expect(translateBody('He pocketed the coins and', 'en', 'pt', { sentence: 'He pocketed the coins and left.', bookId: 'b1' }))
      .toEqual({ text: 'He pocketed the coins and', sourceLang: 'en', targetLang: 'pt', bookId: 'b1' })
  })

  it('translateBody_TextIsTheSentence_OmitsSentence', () => {
    expect(translateBody('Run away!', 'en', 'pt', { sentence: ' run away! ' }).sentence).toBeUndefined()
  })
})
