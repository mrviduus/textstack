/**
 * The two halves of a reader's vocabulary save both mobile readers share (legacy `useReaderVocabActions`, the V2
 * reader #1270): the save with its retries, and the translation a saved card without one gets.
 */
import { uuid } from 'expo-modules-core'
import { syncApi, type VocabularyWordDto } from '@textstack/shared'
import { vocabularyApi } from './vocabularyApi'
import { cachedTranslate } from './translateCache'

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Save with up to 3 attempts + backoff. Absorbs transient network/5xx blips
 *  that previously dropped a tapped word silently (no underline, no retry).
 *  A V2 server answer (`book_not_found`, `deleted`, …) is deterministic: rethrown at once, never retried. Except
 *  `v2_unavailable` (503, "sync paused, try later"): retried as a network failure is. */
export async function saveWordWithRetry(body: Parameters<typeof vocabularyApi.saveWord>[0]) {
  // V2: one card id and one operationId per save, reused by every retry (the server replays it).
  const once = { ...body, id: uuid.v4(), operationId: uuid.v4() }
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await vocabularyApi.saveWord(once)
    } catch (e) {
      const code = syncApi.syncErrorOf(e)?.code
      if (code && code !== 'v2_unavailable') throw e
      lastErr = e
      if (attempt < 2) await delay(350 * (attempt + 1))
    }
  }
  throw lastErr
}

/**
 * TR-2: the translation of a card saved without one, into the reader's native language; null when it has one, or
 * there is nothing to translate into (the book is in the reader's language: no `en` fallback, `lucius → Lucius`).
 * cachedTranslate, so the gloss the toolbar just fetched is reused. Resolves once the translation is known; the
 * PATCH (`onlyIfEmpty`: a translation stored meanwhile is never replaced) goes on behind it, its failure ignored.
 */
export async function fillSavedTranslation(
  saved: Pick<VocabularyWordDto, 'id' | 'translation'>,
  sourceText: string,
  textLanguage: string,
  nativeLanguage: string,
  ctx: { sentence?: string | null; bookId?: string; onStored?: (card: VocabularyWordDto) => void; onSettled?: () => void },
): Promise<string | null> {
  // `onSettled` (#1271, the V2 reader): once, when this fill is over: its write settled, or nothing to write.
  const settle = () => ctx.onSettled?.()
  if (saved.translation || nativeLanguage === textLanguage) return settle(), null
  let translation: string | null | undefined
  try {
    ({ translation } = await cachedTranslate(sourceText, textLanguage, nativeLanguage, { sentence: ctx.sentence ?? undefined, bookId: ctx.bookId }))
  } catch (e) {
    settle()
    throw e
  }
  if (!translation || !saved.id) return settle(), null
  // `onStored` (#1271, the V2 reader): the card as the server holds it after the write, for its local row.
  vocabularyApi.updateWord(saved.id, { translation, onlyIfEmpty: true }).then((card) => ctx.onStored?.(card), () => {}).finally(settle)
  return translation
}
