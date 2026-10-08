import { describe, expect, it } from 'vitest'
import { translateBody, translateCacheKey } from './translation'

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

// Review r4 of #780: one key rule for every client cache — derived from the body that is
// actually sent, so context the server never saw cannot split (or merge) cache entries.
describe('translateCacheKey', () => {
  it('translateCacheKey_PassageWithSentence_SameAsWithout', () => {
    const passage = 'He pocketed the coins and'
    expect(translateCacheKey(passage, 'en', 'pt', { sentence: 'He pocketed the coins and left.' }))
      .toBe(translateCacheKey(passage, 'en', 'pt'))
  })

  it('translateCacheKey_WordDifferentSentences_DifferentKeys', () => {
    expect(translateCacheKey('wound', 'en', 'pt', { sentence: 'She wound the clock.' }))
      .not.toBe(translateCacheKey('wound', 'en', 'pt', { sentence: 'The wound bled.' }))
  })

  it('translateCacheKey_DifferentBooks_DifferentKeys', () => {
    expect(translateCacheKey('wound', 'en', 'pt', { bookId: 'b1' }))
      .not.toBe(translateCacheKey('wound', 'en', 'pt', { bookId: 'b2' }))
  })

  it('translateCacheKey_NullBookIdOrBlankSentence_SameAsNoContext', () => {
    expect(translateCacheKey('wound', 'en', 'pt', { sentence: '  ', bookId: null }))
      .toBe(translateCacheKey('wound', 'en', 'pt'))
  })

  it('translateCacheKey_TextIsTheSentence_SameAsNoSentence', () => {
    expect(translateCacheKey('Run away!', 'en', 'pt', { sentence: 'run away!' }))
      .toBe(translateCacheKey('Run away!', 'en', 'pt'))
  })

  it('translateCacheKey_SurroundingWhitespace_Normalised', () => {
    expect(translateCacheKey('  Wort ', 'de', 'en')).toBe(translateCacheKey('Wort', 'de', 'en'))
  })

  // Review r5 of #780: "US" is not "us", "Turkey" is not "turkey" — the server keys the raw text.
  it('translateCacheKey_DifferentCase_DifferentKeys', () => {
    expect(translateCacheKey('US', 'en', 'pt')).not.toBe(translateCacheKey('us', 'en', 'pt'))
  })
})
