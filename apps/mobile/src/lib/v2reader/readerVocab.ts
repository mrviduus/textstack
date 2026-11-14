/**
 * #1271, Android: the reader's saved words, in memory. Read from the local library's vocabulary feed (`savedWords`:
 * offline too) at each open and after each sync pass; the saves of this session (saved, restored, added anyway) are
 * owed until a read has them, and the translations this session filled until a pull brings them back. The page is
 * sent the book's language's words only (`forBook`); the backfill (vocabWords.mjs `backfillTranslations`, the web's
 * too) fills `backfillable` ones only.
 */
import { vocabMapKey } from '../vocabMapKey'
import { ofBook, wordId } from './vocabWords.mjs'

export interface ReaderWord { id: string; word: string; language: string | null; stage: number; translation: string | null }
/** A save of this session, owed until a read has it: `at`, when it was taken (this device's clock). */
export interface OwedSave extends ReaderWord { at: number }

/** A word's identity: its key and its language (`die` in German is not `die` in English). */
const idOf = (w: Pick<ReaderWord, 'word' | 'language'>) => wordId(vocabMapKey, w.word, w.language)

/** A word saved: it replaces the one with its identity (the server's card), else it is added last (the newest). */
export function withSaved<W extends ReaderWord>(words: readonly W[], w: W): W[] {
  const id = idOf(w)
  const i = words.findIndex((x) => idOf(x) === id)
  // A card saved again keeps the translation it had when the answer has none.
  return i < 0 ? [...words, w] : words.map((x, j) => (j === i ? { ...w, translation: w.translation ?? x.translation } : x))
}

/** A translation for word `id` filled (backfill, a saved card's TR-2 fill); one that has one keeps it. */
export const withTranslation = (words: readonly ReaderWord[], id: string, translation: string): ReaderWord[] =>
  words.map((w) => (w.id === id && !w.translation ? { ...w, translation } : w))

/**
 * The rows just read, as the reader's words: the rows are the truth (a word the pull deleted, a guest's id an adoption
 * dropped, a wipe: gone). This session's `saves` that no row has are kept after them, unless a vocabulary pull that
 * started after the save was read to its end (`readFrom`, when the last such pull started) without it: deleted
 * before this device pulled it, it is owed no more. The ones a row has are done (`saves` returned: what is still
 * owed). A translation this session filled (`filled`, by card id) stays on a row that has none yet (its write not
 * pulled back).
 */
export function mergeWords(rows: readonly ReaderWord[], saves: readonly OwedSave[], filled: ReadonlyMap<string, string>, readFrom: number | null) {
  const have = new Set(rows.map(idOf))
  const owed = saves.filter((s) => !have.has(idOf(s)) && !(readFrom !== null && readFrom >= s.at))
  const fill = (w: ReaderWord): ReaderWord => (!w.translation && filled.has(w.id) ? { ...w, translation: filled.get(w.id)! } : w)
  return { words: [...rows, ...owed.map(({ at: _at, ...w }) => w)].map(fill), saves: owed }
}

/** The words of the book's language (`vocabWords.mjs` `ofBook`; null: a language that does not read, none): what is marked. */
export const forBook = (words: readonly ReaderWord[], language: string | null) => words.filter((w) => ofBook(w.language, language))

/**
 * What the backfill fills: the book's language's words without a translation, never one of this session's owed saves
 * (its own in-context fill, TR-2, may still be in flight), as the web fills only what its load brought.
 */
export function backfillable(words: readonly ReaderWord[], saves: readonly OwedSave[], language: string | null): ReaderWord[] {
  const owed = new Set(saves.map((s) => s.id))
  return forBook(words, language).filter((w) => !w.translation && !owed.has(w.id))
}

/**
 * A guest's nudge count (the whole vocabulary, as legacy counts it): the words in memory when they are the feed's (V2 on
 * and the vocabulary feed pulled at least once: a cursor), else the server's list as before (`legacy`; V2 off, or the
 * first pull not in yet).
 */
export async function nudgeCount(feedPulled: () => Promise<boolean>, words: readonly ReaderWord[], legacy: () => Promise<number>): Promise<number> {
  return (await feedPulled().catch(() => false)) ? words.length : legacy().catch(() => 0)
}
