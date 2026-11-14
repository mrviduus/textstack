// Saved words as both hosts hold them for the marks (#1271). Pure and DOM-free (the Android bundle takes it; the page's
// placement is wordMarks.mjs).

/**
 * A language tag as the marks compare it: trimmed, lower case, its primary subtag (`EN-us` → `en`). The book's side is
 * the language its words are saved under (`opened.lang` through `readLang`, else the host's fallback); a card's side its
 * stored language. Null for none.
 */
export function langOf(tag) {
  const t = typeof tag === 'string' ? tag.trim().toLowerCase().split(/[-_]/)[0] : ''
  return t || null
}

/**
 * Whether a card is one of the book's: the same language. A card whose language is not known (the legacy reader list
 * has none) passes; a book whose language is not known takes none.
 */
export function ofBook(cardLanguage, bookLanguage) {
  const book = langOf(bookLanguage)
  if (!book) return false
  const card = langOf(cardLanguage)
  return card === null || card === book
}

/** A word's identity across the hosts' lists: the vocabulary key (`key`, the host's own) and the language. */
export const wordId = (key, word, language) => `${key(word)}\u0000${langOf(language) ?? ''}`

/**
 * What a host sends the page for its saved words (`{ word, stage, translation }`): the `markWords` list. A host never
 * sends a sentence or any book text.
 */
export const markWordsOf = (entries) => entries.map(({ word, stage, translation }) => ({ word, stage, gloss: translation || null }))
