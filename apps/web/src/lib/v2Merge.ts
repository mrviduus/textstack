import { rekeyPendingSessions, type V2MergeMap, type PendingSession } from '@textstack/shared'
import {
  getAllStoredHighlights, saveHighlight, listPendingVocabWords, deletePendingVocabWord, addPendingVocabWord,
} from './offlineDb'

export type { V2MergeMap } from '@textstack/shared'

/** The localStorage records keyed by a user book's id. */
const BOOK_KEYS = ['userbook.progress.', 'reader.pdfPage.', 'reader.pdfPageAt.']
const SESSIONS_KEY = 'reading.pendingSessions'

/**
 * PDD "Guest → account merge": re-key what this browser holds under the guest's ids before the
 * first V2 pull — highlights (their book), queued vocabulary saves (their card), the reading
 * records and queued sessions (their book). File ids are not stored locally (each write reads the
 * book's current file), and the in-memory V2 cache is reset by the caller. Best effort: storage that
 * is unavailable keeps its old ids, and their writes are then refused and dropped.
 */
export async function applyV2MergeMap(map: V2MergeMap): Promise<void> {
  const books = map.books ?? {}
  const words = map.words ?? {}

  for (const h of await getAllStoredHighlights().catch(() => [])) {
    const to = h.userBookId && books[h.userBookId]
    if (to) await saveHighlight({ ...h, userBookId: to }).catch(() => {})
  }

  for (const p of await listPendingVocabWords().catch(() => [])) {
    const to = words[p.wordId ?? p.id]
    if (!to) continue
    // The id stays (it is the save's operationId); only the card it lands on changes.
    await deletePendingVocabWord(p.id).catch(() => {})
    await addPendingVocabWord({ ...p, wordId: to }).catch(() => {})
  }

  try {
    for (const [from, to] of Object.entries(books)) {
      for (const prefix of BOOK_KEYS) {
        const value = localStorage.getItem(prefix + from)
        if (value == null) continue
        localStorage.setItem(prefix + to, value)
        localStorage.removeItem(prefix + from)
      }
    }
    const sessions = rekeyPendingSessions(JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]') as PendingSession[], books)
    if (sessions) localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions))
  } catch {
    // localStorage unavailable
  }
}
