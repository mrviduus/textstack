// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { MAX_GLOSS, MAX_WORD, MAX_WORDS, STAGE_COLORS, readGlosses, readMarkWords, sameMark, shortGloss, stageOf, withGlosses, wordMarksIn } from './wordMarks.mjs'
import { langOf, markWordsOf, ofBook, wordId } from './vocabWords.mjs'

describe('the gloss setting (legacy showInlineTranslations)', () => {
  it('is on unless stored false; a damaged value is on', () => {
    expect([null, '{}', '{"showInlineTranslations":true}', '{"showInlineTranslations":false}', 'nope', '[]'].map(readGlosses)).toEqual([true, true, true, false, true, true])
  })
  it('a change keeps every other stored field', () => {
    expect(JSON.parse(withGlosses('{"fontSize":22,"showInlineTranslations":true}', false))).toEqual({ fontSize: 22, showInlineTranslations: false })
    expect(JSON.parse(withGlosses('broken', true))).toEqual({ showInlineTranslations: true })
    expect(JSON.parse(withGlosses(null, false))).toEqual({ showInlineTranslations: false })
  })
})

/** The marks in a body of `html`, as `[text under the mark, word, stage]`. */
function marks(html: string, words: { word: string; stage?: number; gloss?: string | null }[]) {
  document.body.innerHTML = html
  return wordMarksIn(document.body, readMarkWords(words)).map(({ range, word }) => [range.toString(), word.word, word.stage])
}

describe('wordMarksIn', () => {
  it('marks every occurrence of a saved word, any case, whole words only, in document order', () => {
    expect(marks('<p>Keeper of the keepers. The KEEPER slept.</p><p>keeper</p>', [{ word: 'keeper', stage: 2 }])).toEqual([
      ['Keeper', 'keeper', 2], ['KEEPER', 'keeper', 2], ['keeper', 'keeper', 2],
    ])
  })

  it('a phrase is matched before its words, never also as them', () => {
    expect(marks('<p>We met before dawn. Dawn came.</p>', [{ word: 'dawn', stage: 0 }, { word: 'before dawn', stage: 3 }])).toEqual([
      ['before dawn', 'before dawn', 3], ['Dawn', 'dawn', 0],
    ])
  })

  it('a block or a footnote ends a word; script and style text is never marked', () => {
    expect(marks('<p>keep<sup>1</sup>er</p><style>keeper{}</style><p>keeper</p>', [{ word: 'keeper' }])).toEqual([['keeper', 'keeper', 0]])
  })

  it('a soft hyphen inside the word is part of it', () => {
    expect(marks('<p>kee­per here</p>', [{ word: 'keeper' }])).toEqual([['kee­per', 'keeper', 0]])
  })

  it('no words, or no root: nothing', () => {
    document.body.innerHTML = '<p>keeper</p>'
    expect(wordMarksIn(document.body, [])).toEqual([])
    expect(wordMarksIn(null, readMarkWords([{ word: 'keeper' }]))).toEqual([])
  })
})

describe('readMarkWords', () => {
  it('keeps the known fields; a stage off the list is new (0); a blank or over-long gloss is none', () => {
    expect(readMarkWords([
      { word: 'a', stage: 4, gloss: ' x ' },
      { word: 'b', stage: 9, gloss: '' },
      { word: 'c', stage: 1.5, gloss: 'y'.repeat(MAX_GLOSS + 1) },
      { word: 'd', stage: '2', gloss: 3, extra: 1 },
    ])).toEqual([
      { word: 'a', stage: 4, gloss: 'x' },
      { word: 'b', stage: 0, gloss: null },
      { word: 'c', stage: 0, gloss: null },
      { word: 'd', stage: 0, gloss: null },
    ])
  })

  it('drops an item with no word, a blank or over-long one; anything not a list is none', () => {
    expect(readMarkWords([null, 'keeper', { word: '  ' }, { word: 'x'.repeat(MAX_WORD + 1) }, { stage: 1 }, { word: 'ok' }])).toEqual([{ word: 'ok', stage: 0, gloss: null }])
    expect(readMarkWords({ word: 'keeper' })).toEqual([])
    expect(readMarkWords(null)).toEqual([])
  })

  it('takes at most MAX_WORDS, the newest (the last sent, a word just saved)', () => {
    const read = readMarkWords(Array.from({ length: MAX_WORDS + 5 }, (_, i) => ({ word: `w${i}` })))
    expect(read).toHaveLength(MAX_WORDS)
    expect(read[0].word).toBe('w5')
    expect(read[MAX_WORDS - 1].word).toBe(`w${MAX_WORDS + 4}`)
  })
})

describe('stage colours', () => {
  it('are the legacy five, an unknown stage drawn as new', () => {
    expect(STAGE_COLORS).toEqual(['rgba(59,130,246,0.5)', 'rgba(234,179,8,0.5)', 'rgba(234,179,8,0.4)', 'rgba(34,197,94,0.4)', 'rgba(34,197,94,0.25)'])
    expect([0, 4, 5, -1, null].map(stageOf)).toEqual([0, 4, 0, 0, 0])
  })
})

describe('markWordsOf / sameMark', () => {
  it('a host sends word, stage and translation as the gloss (none when empty)', () => {
    expect(markWordsOf([{ word: 'a', stage: 1, translation: 'x' }, { word: 'b', stage: 0, translation: '' }, { word: 'c', stage: 2 }])).toEqual([
      { word: 'a', stage: 1, gloss: 'x' }, { word: 'b', stage: 0, gloss: null }, { word: 'c', stage: 2, gloss: null },
    ])
  })

  it('two marks draw the same only with the same stage and gloss', () => {
    expect(sameMark({ stage: 1, gloss: 'x' }, { stage: 1, gloss: 'x' })).toBe(true)
    expect(sameMark({ stage: 1, gloss: 'x' }, { stage: 2, gloss: 'x' })).toBe(false)
    expect(sameMark({ stage: 1, gloss: 'x' }, { stage: 1, gloss: null })).toBe(false)
    expect(sameMark(undefined, { stage: 1, gloss: null })).toBe(false)
  })
})

describe('vocabWords: the book\'s language', () => {
  it('a tag compares by its primary subtag, any case', () => {
    expect(['en', 'EN-us', ' pt_BR ', '', null, 3].map(langOf)).toEqual(['en', 'en', 'pt', null, null, null])
  })
  it('a card of another language is not the book\'s, nor one with no language (the legacy list); a book with none takes none', () => {
    expect(ofBook('en-GB', 'en')).toBe(true)
    expect(ofBook('de', 'en')).toBe(false)
    expect(ofBook(undefined, 'en')).toBe(false)
    expect(ofBook('', 'en')).toBe(false)
    expect(ofBook('en', null)).toBe(false)
  })
  it('a word is its key and its language', () => {
    const key = (w: string) => w.toLowerCase()
    expect(wordId(key, 'Die', 'de')).toBe(wordId(key, 'die', 'DE-at'))
    expect(wordId(key, 'die', 'de')).not.toBe(wordId(key, 'die', 'en'))
  })
})

describe('a translation over its word', () => {
  it('readMarkWords_GlossWithSeveralMeanings_KeepsTheFirstSoTheLabelStaysOverItsWord', () => {
    expect(readMarkWords([{ word: 'superseded', gloss: 'заменённый (устаревший)' }])[0].gloss).toBe('заменённый')
    expect(shortGloss('заменённый (устаревший)')).toBe('заменённый')
    expect(shortGloss('подчёркивать, выделять')).toBe('подчёркивать')
    expect(shortGloss('продукт; изделие')).toBe('продукт')
    expect(shortGloss('продукт')).toBe('продукт')
    expect(shortGloss('(устар.) ветхий')).toBe('(устар.) ветхий')
    expect(shortGloss('км/ч')).toBe('км/ч')
  })
})
