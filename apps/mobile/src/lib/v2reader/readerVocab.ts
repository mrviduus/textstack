/**
 * #1271, Android: the reader's saved words are the local library's `vocabulary` rows (the feed's, and this device's own
 * saves' answers). The page is sent the book's language's words only (`forBook`); the backfill (vocabWords.mjs
 * `backfillTranslations`, the web's too) fills `backfillable` ones.
 */
import { ofBook } from './vocabWords.mjs'

export interface ReaderWord { id: string; word: string; language: string | null; stage: number; translation: string | null }

/** The words of the book's language (`vocabWords.mjs` `ofBook`; null: a language that does not read, none): what is marked. */
export const forBook = (words: readonly ReaderWord[], language: string | null) => words.filter((w) => ofBook(w.language, language))

/** What the backfill fills: the book's language's words without a translation. */
export const backfillable = (words: readonly ReaderWord[], language: string | null) => forBook(words, language).filter((w) => !w.translation)

/**
 * The row a save's answer card makes (saved, already saved, restored, added anyway; the pull's shape), or null: no card,
 * no language to file it under (the card's, else the book's), or the user changed since the save was asked (`asker`
 * is not `user`: the answer is another session's and lands nowhere).
 */
export function answerRow(
  card: { id: string; word: string; language?: string | null; stage: number; translation: string | null } | null | undefined,
  asker: string | null,
  user: string | null,
  bookLanguage: string | null,
): { id: string; word: string; language: string; stage: number; translation: string | null } | null {
  const language = card?.language || bookLanguage
  if (!card || !language || asker !== user) return null
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
