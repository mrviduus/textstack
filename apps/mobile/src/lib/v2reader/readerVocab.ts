/**
 * #1271, Android: the reader's saved words are the local library's `vocabulary` rows (the feed's, and this device's own
 * saves' answers). The page is sent the book's language's words only (`forBook`); the backfill (vocabWords.mjs
 * `backfillTranslations`, the web's too) fills `backfillable` ones.
 */
import { ofBook } from './vocabWords.mjs'

export interface ReaderWord { id: string; word: string; language: string | null; stage: number; translation: string | null }

/** The words of the book's language (`vocabWords.mjs` `ofBook`; null: a language that does not read, none): what is marked. */
export const forBook = (words: readonly ReaderWord[], language: string | null) => words.filter((w) => ofBook(w.language, language))

/**
 * What the backfill fills: the book's language's words without a translation, none whose own TR-2 fill is still in
 * flight in this process (`busy`, card ids).
 */
export const backfillable = (words: readonly ReaderWord[], language: string | null, busy: ReadonlySet<string> = new Set()) =>
  forBook(words, language).filter((w) => !w.translation && !busy.has(w.id))

/**
 * Whether `user` may read and write the local library owned by `owner` (meta.account): it is theirs, or nobody's yet.
 * A library another identity owns (a wipe that failed) is never read for marks nor written.
 */
export const ownsLibrary = (owner: string | null, user: string | null) => owner === null || owner === user

/** The translation a card holds after our write (`onlyIfEmpty` keeps one it had): what its row takes, never ours. */
export const serverTranslation = (card: { translation?: string | null } | null | undefined) => card?.translation || null

/**
 * The row a save's answer card makes (saved, already saved, restored, added anyway; the pull's shape), or null: the
 * save did not go through V2 (`viaV2` false: a legacy card is no V2 row; the next V2 pull brings it), no card, no
 * language to file it under (the card's, else the book's), or the user changed since the save was asked (`asker` is
 * not `user`: the answer is another session's and lands nowhere).
 */
export function answerRow(
  card: { id: string; word: string; language?: string | null; stage: number; translation: string | null } | null | undefined,
  asker: string | null,
  user: string | null,
  bookLanguage: string | null,
  viaV2: boolean,
): { id: string; word: string; language: string; stage: number; translation: string | null } | null {
  const language = card?.language || bookLanguage
  if (!viaV2 || !card || !language || asker !== user) return null
  return { id: card.id, word: card.word, language, stage: card.stage, translation: card.translation }
}

/**
 * A guest's nudge count (the whole vocabulary, as legacy counts it): the rows when they are the feed's (V2 on and the
 * vocabulary feed pulled at least once: a cursor), else the server's list as before (`legacy`; V2 off, or the first
 * pull not in yet).
 */
export async function nudgeCount(feedPulled: () => Promise<boolean>, words: readonly ReaderWord[], legacy: () => Promise<number>): Promise<number> {
  return (await feedPulled().catch(() => false)) ? words.length : legacy().catch(() => 0)
}
