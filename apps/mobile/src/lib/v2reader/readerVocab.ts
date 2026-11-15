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
/**
 * A save of this session, owed until a read has it: `pulls`, how many vocabulary pulls had started when it was taken
 * (`vocabularyPulls().started`: a local counter, so a clock set back changes nothing).
 */
export interface OwedSave extends ReaderWord { pulls: number }
/**
 * A save not stamped yet (its stamp read failed, or has not landed): owed, never expired, until a read stamps it with
 * the pulls started by then (`mergeWords`' `started`: later than the save, so it only ever delays the expiry).
 */
export const UNSTAMPED = Number.MAX_SAFE_INTEGER

/**
 * What a change of session does to this session's saved words (#1271 review): `keep` when a guest became an account
 * (the same person: the server merged the guest's cards into the account's, so the ✓, the owed saves and late answers
 * stay; the next read re-resolves ids through the merged rows), `clear` for anything else that changes the user (a
 * sign-out, another account, another guest), `same` when nothing changed.
 */
export function sessionStep(prev: { id: string | null; guest: boolean }, next: { id: string | null; guest: boolean }): 'same' | 'keep' | 'clear' {
  if (prev.id === next.id) return 'same'
  return prev.id !== null && prev.guest && next.id !== null && !next.guest ? 'keep' : 'clear'
}

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
 * started after the save (`readFrom`, the number of the last pull read to its end, above the save's `pulls`) was read
 * to its end without it: deleted before this device pulled it, it is owed no more. The ones a row has are done
 * (`saves` returned: what is still owed). A translation this session filled (`filled`, by card id) stays on a row
 * that has none yet (its write not pulled back).
 * ponytail: relies on the change feed's overlap (ChangeFeed.Overlap, 30 s) covering the save's commit lag: a server
 * transaction longer than that could expire a just-saved word's mark until its row changes again. A per-user change
 * sequence on the server if that ever shows.
 */
export function mergeWords(rows: readonly ReaderWord[], saves: readonly OwedSave[], filled: ReadonlyMap<string, string>, readFrom: number | null, started?: number) {
  const have = new Set(rows.map(idOf))
  const owed = saves
    .filter((s) => !have.has(idOf(s)) && !(readFrom !== null && readFrom > s.pulls))
    .map((s) => (s.pulls === UNSTAMPED && started !== undefined ? { ...s, pulls: started } : s))
  const fill = (w: ReaderWord): ReaderWord => (!w.translation && filled.has(w.id) ? { ...w, translation: filled.get(w.id)! } : w)
  return { words: [...rows, ...owed.map(({ pulls: _pulls, ...w }) => w)].map(fill), saves: owed }
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
