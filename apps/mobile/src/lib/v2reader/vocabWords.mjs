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
 * Whether a card is one of the book's: the same language. A card whose language is not known (the legacy list, when V2
 * is not answering) is not: the V2 reader marks and fills by language, so it marks and fills none of those. A book whose
 * language is not known takes none.
 */
export function ofBook(cardLanguage, bookLanguage) {
  const book = langOf(bookLanguage)
  return !!book && langOf(cardLanguage) === book
}

/** A word's identity across the hosts' lists: the vocabulary key (`key`, the host's own) and the language. */
export const wordId = (key, word, language) => `${key(word)}\u0000${langOf(language) ?? ''}`

/**
 * What a host sends the page for its saved words (`{ word, stage, translation }`): the `markWords` list. A host never
 * sends a sentence or any book text.
 */
export const markWordsOf = (entries) => entries.map(({ word, stage, translation }) => ({ word, stage, gloss: translation || null }))

const limited = (e) => e?.status === 429

/**
 * The once-per-open backfill, both hosts' (the legacy readers' rule): each of `words` (the caller's: the book's language,
 * no translation, a server card) is translated (`translate`, from the book's language into the reader's), handed to
 * `onWord`, and stored on its card (`persist`: `onlyIfEmpty`) before the next one: never a burst of writes. Nothing when
 * there is no other language to translate into. A word that fails is skipped; a 429 (translate or write) stops it, and
 * so does `cancelled` (a newer load, identity or language; the host gone).
 */
export async function backfillTranslations(words, from, to, io) {
  if (!from || !to || to === from) return
  for (const w of words) {
    if (io.cancelled()) return
    let t = null
    try { t = await io.translate(w.word) } catch (e) { if (limited(e)) return }
    if (!t || io.cancelled()) continue
    io.onWord(w.id, t)
    try { await io.persist(w.id, t) } catch (e) { if (limited(e)) return }
  }
}
