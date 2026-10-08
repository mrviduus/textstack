import { describe, it, expect } from 'vitest'
import { makeTranslationKey } from './offlineDb'

// Review of #780: the server varies a translation by book (genre bias), so the local
// cache must too. A call without a bookId keeps the key it always had.
describe('makeTranslationKey', () => {
  it('makeTranslationKey_DifferentBooks_DifferentKeys', () => {
    expect(makeTranslationKey('en', 'pt', 'wound', 'She wound it.', 'b1'))
      .not.toBe(makeTranslationKey('en', 'pt', 'wound', 'She wound it.', 'b2'))
  })

  it('makeTranslationKey_BookVsNoBook_DifferentKeys', () => {
    expect(makeTranslationKey('en', 'pt', 'wound', 'She wound it.', 'b1'))
      .not.toBe(makeTranslationKey('en', 'pt', 'wound', 'She wound it.'))
  })

  it('makeTranslationKey_NoBookId_SameAsNullBookId', () => {
    expect(makeTranslationKey('en', 'pt', 'wound', 'She wound it.', null))
      .toBe(makeTranslationKey('en', 'pt', 'wound', 'She wound it.'))
  })

  // Review r4 of #780: a passage is sent without its sentence, so the sentence is not in its key.
  it('makeTranslationKey_PassageWithSentence_SameAsWithout', () => {
    const passage = 'He pocketed the coins and'
    expect(makeTranslationKey('en', 'pt', passage, 'He pocketed the coins and left.'))
      .toBe(makeTranslationKey('en', 'pt', passage))
  })

  it('makeTranslationKey_WordDifferentSentences_DifferentKeys', () => {
    expect(makeTranslationKey('en', 'pt', 'wound', 'She wound the clock.'))
      .not.toBe(makeTranslationKey('en', 'pt', 'wound', 'The wound bled.'))
  })
})
