// The seam's `vocabulary` and `highlights` on Android. Saving a word needs the network, as in the Expo app (owner
// 2026-11-28): the web calls, in bearer mode here. The reader's marks read the device's `vocabulary` rows (server cards
// a sync pass pulled, and each card this device's own saves answered with), so they show offline (#1271).
import { highlightCoverUrl, highlightsApi, isOfflineError, type HighlightListItem } from '@textstack/shared'
import * as web from '../../api/vocabulary'
import type { Platform } from '../index'
import { storedUser } from './account'
import { getAccessToken } from './api'
import { deviceLocalLibrary } from './deviceLibrary'
import { resetSince } from './syncClient'

/** The device rows may answer for this user: the library is theirs or nobody's (a failed wipe's rows are another's). */
async function ownRows(): Promise<boolean> {
  const user = await storedUser()
  const owner = await deviceLocalLibrary().account()
  return owner === null || owner === user?.id
}

export const vocabulary: Platform['vocabulary'] = {
  async saveWord(data) {
    // The asker and the session are taken before the call: a sign-out or a wipe meanwhile writes no row.
    const user = (await storedUser())?.id ?? null
    const stale = resetSince()
    const res = await web.saveWord(data)
    const w = res.word
    if (w) {
      await deviceLocalLibrary().upsertWord({ id: w.id, word: w.word, language: w.language, stage: w.stage, translation: w.translation }, { user, stale })
        .catch((e: unknown) => console.warn('[v2] saved word not kept on the device:', e))
    }
    return res
  },
  getWords: (...a) => web.getWords(...a),
  deleteWord: (...a) => web.deleteWord(...a),
  deleteAllWords: (...a) => web.deleteAllWords(...a),
  updateWord: (...a) => web.updateWord(...a),
  restoreWord: (...a) => web.restoreWord(...a),
  /** The device's rows (no network): a pass keeps them current (Expo ReaderScreen `readVocab`). */
  async getReaderVocab() {
    if (!(await ownRows())) return []
    return (await deviceLocalLibrary().savedWords()).map((w) => ({ id: w.id, word: w.word, stage: w.stage, translation: w.translation ?? undefined, language: w.language }))
  },
  getReviewQueue: (...a) => web.getReviewQueue(...a),
  submitReview: (...a) => web.submitReview(...a),
}

/** A device highlight in the list's shape: the book and the text, nothing the device does not keep. */
const listItem = (h: { id: string; bookId: string; bookTitle: string; text: string; color: string; note: string | null }): HighlightListItem => ({
  id: h.id, selectedText: h.text, anchorJson: JSON.stringify({ exact: h.text }), color: h.color, noteText: h.note, createdAt: '',
  editionId: null, editionTitle: null, editionSlug: null, editionCoverPath: null,
  userBookId: h.bookId, userBookTitle: h.bookTitle, userBookCoverPath: null, userBookCoverVersion: null,
  chapterId: null, userChapterId: null, chapterTitle: null, userChapterTitle: null, chapterSlug: null, userChapterSlug: null, deletedBookTitle: null,
})

export const highlights: Platform['highlights'] = {
  /** The server's list online (every device's); offline, or with no session, this device's highlights. */
  async getAllHighlights(q) {
    const device = async () => {
      if (!(await ownRows())) return { items: [], totalCount: 0 }
      const items = (await deviceLocalLibrary().deviceHighlights(q?.limit ?? 50)).map(listItem)
      return { items, totalCount: items.length }
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
