// The seam's `vocabulary` and `highlights` on Android. Saving a word needs the network, as in the Expo app (owner
// 2026-11-28): the web calls, in bearer mode here. The reader's marks read the device's `vocabulary` rows (server cards
// a sync pass pulled, and each card this device's own saves answered with), so they show offline (#1271).
import { highlightCoverUrl, highlightsApi, isOfflineError, type HighlightListItem, type VocabularyWordDto } from '@textstack/shared'
import * as web from '../../api/vocabulary'
import type { Platform } from '../index'
import { storedUser } from './account'
import { getAccessToken } from './api'
import { deviceLocalLibrary } from './deviceLibrary'
import { syncSoon } from './library'
import { resetSince } from './syncClient'

/** The device rows may answer for this user: the library is theirs or nobody's (a failed wipe's rows are another's). */
async function ownRows(): Promise<boolean> {
  const user = await storedUser()
  const owner = await deviceLocalLibrary().account()
  return owner === null || owner === user?.id
}

/**
 * A server card a write of this device answered with, into the device rows (Expo `takeWord`), so the marks show it
 * at the next open. The asker and the session are taken before the call: a sign-out or a wipe meanwhile writes no row.
 */
async function keeping<T>(call: () => Promise<T>, cardOf: (res: T) => VocabularyWordDto | null): Promise<T> {
  const user = (await storedUser())?.id ?? null
  const stale = resetSince()
  const res = await call()
  const w = cardOf(res)
  if (w) {
    await deviceLocalLibrary().upsertWord({ id: w.id, word: w.word, language: w.language, stage: w.stage, translation: w.translation }, { user, stale })
      .catch((e: unknown) => console.warn('[v2] saved word not kept on the device:', e))
  }
  return res
}

/** After a delete: a pass pulls the tombstones, so the rows (and the marks) lose the words (as Expo). */
const afterDelete = async <T>(p: Promise<T>) => { const res = await p; syncSoon(); return res }

export const vocabulary: Platform['vocabulary'] = {
  // A `deleted` answer carries the tombstone: no row (the reader offers the restore).
  saveWord: (data) => keeping(() => web.saveWord(data), (res) => (res.outcome === 'deleted' ? null : res.word)),
  getWords: (...a) => web.getWords(...a),
  deleteWord: (...a) => afterDelete(web.deleteWord(...a)),
  deleteAllWords: (...a) => afterDelete(web.deleteAllWords(...a)),
  // The answer is the server's card: its translation replaces the row's (a fill and a replace alike).
  updateWord: (...a) => keeping(() => web.updateWord(...a), (w) => w),
  restoreWord: (...a) => keeping(() => web.restoreWord(...a), (w) => w),
  /**
   * The device's rows, with no network (Expo ReaderScreen `readVocab`): a pass keeps them current. Before the
   * vocabulary feed was ever pulled here (a fresh sign-in), the server's list when it answers.
   */
  async getReaderVocab() {
    if (!(await ownRows())) return []
    const lib = deviceLocalLibrary()
    if ((await lib.cursor('vocabulary')) === null && (await getAccessToken().catch(() => null))) {
      try { return await web.getReaderVocab() } catch { /* offline: the rows */ }
    }
    return (await lib.savedWords()).map((w) => ({ id: w.id, word: w.word, stage: w.stage, translation: w.translation ?? undefined, language: w.language }))
  },
  getReviewQueue: (...a) => web.getReviewQueue(...a),
  submitReview: (...a) => web.submitReview(...a),
}

/** A device highlight in the list's shape: the book and the text, nothing the device does not keep. */
const listItem = (h: { id: string; bookId: string; bookTitle: string; text: string; color: string; note: string | null; at: number | null }): HighlightListItem => ({
  id: h.id, selectedText: h.text, anchorJson: JSON.stringify({ exact: h.text }), color: h.color, noteText: h.note,
  createdAt: new Date(h.at ?? 0).toISOString(),
  editionId: null, editionTitle: null, editionSlug: null, editionCoverPath: null,
  userBookId: h.bookId, userBookTitle: h.bookTitle, userBookCoverPath: null, userBookCoverVersion: null,
  chapterId: null, userChapterId: null, chapterTitle: null, userChapterTitle: null, chapterSlug: null, userChapterSlug: null, deletedBookTitle: null,
})

export const highlights: Platform['highlights'] = {
  /** The server's list online (every device's); offline, or with no session, this device's highlights. */
  async getAllHighlights(q) {
    // The page's filters too (search, colour, sort, a page). ponytail: every device row read, then filtered here.
    const device = async () => {
      if (!(await ownRows())) return { items: [], totalCount: 0 }
      const search = q?.search?.trim().toLowerCase()
      const all = (await deviceLocalLibrary().deviceHighlights(Number.MAX_SAFE_INTEGER)).map(listItem)
        .filter((h) => (!q?.color || h.color === q.color) && (!search || `${h.selectedText} ${h.noteText ?? ''} ${h.userBookTitle}`.toLowerCase().includes(search)))
      if (q?.sort === 'oldest') all.reverse()
      const from = q?.offset ?? 0
      return { items: all.slice(from, from + (q?.limit ?? 50)), totalCount: all.length }
    }
    if (!(await getAccessToken().catch(() => null))) return device()
    try {
      return await highlightsApi.getAllHighlights(q)
    } catch (e) {
      if (isOfflineError(e)) return device()
      throw e
    }
  },
  // Runs in render: never throws (null without a cover).
  coverUrl: (h) => highlightCoverUrl(h),
}
