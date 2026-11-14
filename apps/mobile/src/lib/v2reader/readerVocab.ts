/**
 * #1271, Android: the reader's saved words for one open, in memory. Read once from the local library's vocabulary feed
 * (`savedWords`: offline too), updated by this open's saves, their missing translations filled once (the legacy
 * readers' backfill, `useReaderVocabMap`). What the page marks (wordMarks.mjs `markWordsOf`) and what a guest's
 * nudge counts (the whole vocabulary, as legacy counted it).
 */
import { vocabMapKey } from '../vocabMapKey'

export interface ReaderWord { id: string; word: string; stage: number; translation: string | null }

/** A word saved in this open: it replaces the one with its key (the server's card), else it is added. */
export function withSaved(words: readonly ReaderWord[], w: ReaderWord): ReaderWord[] {
  const key = vocabMapKey(w.word)
  const i = words.findIndex((x) => vocabMapKey(x.word) === key)
  // A card saved again keeps the translation it had when the answer has none.
  return i < 0 ? [...words, w] : words.map((x, j) => (j === i ? { ...w, translation: w.translation ?? x.translation } : x))
}

/** A translation for word `id` filled (backfill, a saved card's TR-2 fill); one that has one keeps it. */
export const withTranslation = (words: readonly ReaderWord[], id: string, translation: string): ReaderWord[] =>
  words.map((w) => (w.id === id && !w.translation ? { ...w, translation } : w))

/**
 * The rows read again after a sync pass (another device's words, this device's first pull) over the open's words:
 * the rows win, a word saved in this open and not pulled yet is kept, and a translation this open filled stays on a
 * row that has none yet (its PATCH not pulled back).
 */
export function mergeWords(rows: readonly ReaderWord[], open: readonly ReaderWord[]): ReaderWord[] {
  const byKey = new Map(open.map((w) => [vocabMapKey(w.word), w]))
  const out = rows.map((r) => {
    const mine = byKey.get(vocabMapKey(r.word))
    byKey.delete(vocabMapKey(r.word))
    return !r.translation && mine?.translation ? { ...r, translation: mine.translation } : r
  })
  return [...out, ...byKey.values()]
}

/**
 * The legacy backfill, once per open: each word without a translation is translated (`translate`, from the book's
 * language into the reader's) one at a time, stored on its card (`persist`: `onlyIfEmpty`, a failure ignored) and
 * handed to `onWord` as it lands. Nothing when there is no other language to translate into. A word that fails is
 * skipped; `cancelled` (a new open) stops the loop.
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
  for (const w of words.filter((x) => !x.translation)) {
    if (io.cancelled()) return
    const t = await io.translate(w.word).catch(() => null)
    if (!t || io.cancelled()) continue
    io.onWord(w.id, t)
    io.persist(w.id, t).catch(() => {})
  }
}
