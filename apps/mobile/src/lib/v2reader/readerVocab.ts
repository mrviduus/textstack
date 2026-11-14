/**
 * #1271, Android: the reader's saved words, in memory. Read from the local library's vocabulary feed (`savedWords`:
 * offline too) at each open and after each sync pass; the saves of this session (saved, restored, added anyway) are
 * tracked until a read has them, and the translations this session filled until a pull brings them back. The page is
 * sent the book's language's words only (`forBook`); the backfill fills those only.
 */
import { vocabMapKey } from '../vocabMapKey'
import { ofBook, wordId } from './vocabWords.mjs'

export interface ReaderWord { id: string; word: string; language: string | null; stage: number; translation: string | null }

/** A word's identity: its key and its language (`die` in German is not `die` in English). */
const idOf = (w: Pick<ReaderWord, 'word' | 'language'>) => wordId(vocabMapKey, w.word, w.language)

/** A word saved: it replaces the one with its identity (the server's card), else it is added last (the newest). */
export function withSaved(words: readonly ReaderWord[], w: ReaderWord): ReaderWord[] {
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
 * dropped, a wipe: gone); this session's `saves` that no row has yet are kept after them, the ones a row has are done
 * (`saves` returned: what is still owed); a translation this session filled (`filled`, by card id) stays on a row that
 * has none yet (its write not pulled back).
 */
export function mergeWords(rows: readonly ReaderWord[], saves: readonly ReaderWord[], filled: ReadonlyMap<string, string>) {
  const have = new Set(rows.map(idOf))
  const owed = saves.filter((s) => !have.has(idOf(s)))
  const fill = (w: ReaderWord) => (!w.translation && filled.has(w.id) ? { ...w, translation: filled.get(w.id)! } : w)
  return { words: [...rows, ...owed].map(fill), saves: owed }
}

/** The words of the book's language (`vocabWords.mjs` `ofBook`): what is marked and filled. */
export const forBook = (words: readonly ReaderWord[], language: string | null) => words.filter((w) => ofBook(w.language, language))

const limited = (e: unknown) => (e as { status?: number } | null)?.status === 429

/**
 * The legacy backfill, once per open: each word without a translation is translated (`translate`, from the book's
 * language into the reader's), handed to `onWord`, and stored on its card (`persist`: `onlyIfEmpty`) before the next
 * one: never a burst of writes. Nothing when there is no other language to translate into. A word that fails is
 * skipped; a 429 (translate or write) stops it, and so does `cancelled` (a new open, the screen gone).
 */
export async function backfillTranslations(
  words: readonly ReaderWord[],
  from: string,
  to: string | null,
  io: {
    translate: (word: string) => Promise<string | null>
    persist: (id: string, translation: string) => Promise<unknown>
    onWord: (id: string, translation: string) => void
    cancelled: () => boolean
  },
): Promise<void> {
  if (!to || to === from) return
  for (const w of forBook(words, from).filter((x) => !x.translation)) {
    if (io.cancelled()) return
    let t: string | null = null
    try { t = await io.translate(w.word) } catch (e) { if (limited(e)) return }
    if (!t || io.cancelled()) continue
    io.onWord(w.id, t)
    try { await io.persist(w.id, t) } catch (e) { if (limited(e)) return }
  }
}

/**
 * A guest's nudge count (the whole vocabulary, as legacy counts it): the words in memory when they are the feed's (V2 on
 * and the vocabulary feed pulled at least once: a cursor), else the server's list as before (`legacy`; V2 off, or the
 * first pull not in yet).
 */
export async function nudgeCount(feedPulled: () => Promise<boolean>, words: readonly ReaderWord[], legacy: () => Promise<number>): Promise<number> {
  return (await feedPulled().catch(() => false)) ? words.length : legacy().catch(() => 0)
}
