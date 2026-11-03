/**
 * `@textstack/shared`'s `userBooksApi`, switched per call to V2 when the server has `Features:V2Api`
 * (#1025 M2.7) — the one switch for every screen and hook, as web's `api/userBooks.ts`. With V2 off
 * each call is the shared one, unchanged.
 *
 * On V2 only open, read, progress, finish and delete exist; the screens hide the rest by
 * `V2_FEATURES` (`useV2()`), and bookmarks list empty.
 */
import { userBooksApi as legacy } from '@textstack/shared'
import {
  onV2, v2Enabled, getV2UserBooks, getV2UserBook, getV2UserBookChapter, removeV2Book, v2FileUrl,
  readV2Progress, saveV2Progress, completeV2Book, uncompleteV2Book, type V2WriteOutcome,
} from './v2'

type UpdateProgress = Parameters<typeof legacy.updateUserBookProgress>[1]

export const userBooksApi = {
  ...legacy,
  getUserBooks: async () => ((await onV2()) ? getV2UserBooks() : legacy.getUserBooks()),
  getUserBook: async (id: string) => ((await onV2()) ? getV2UserBook(id) : legacy.getUserBook(id)),
  getUserBookChapter: async (bookId: string, slug: string) =>
    ((await onV2()) ? getV2UserBookChapter(bookId, slug) : legacy.getUserBookChapter(bookId, slug)),
  deleteUserBook: async (id: string) => ((await onV2()) ? removeV2Book(id) : legacy.deleteUserBook(id)),
  getUserBookProgress: async (bookId: string) =>
    ((await onV2()) ? readV2Progress(bookId) : legacy.getUserBookProgress(bookId)),
  /** On V2 the revision rule decides (`V2WriteOutcome`). */
  updateUserBookProgress: async (bookId: string, data: UpdateProgress): Promise<V2WriteOutcome | void> =>
    ((await onV2()) ? saveV2Progress(bookId, data) : legacy.updateUserBookProgress(bookId, data)),
  markUserBookComplete: async (id: string) => ((await onV2()) ? completeV2Book(id) : legacy.markUserBookComplete(id)),
  unmarkUserBookComplete: async (id: string) => ((await onV2()) ? uncompleteV2Book(id) : legacy.unmarkUserBookComplete(id)),
  getUserBookBookmarks: async (bookId: string) => ((await onV2()) ? [] : legacy.getUserBookBookmarks(bookId)),
  getUserBookFileUrl: (id: string, apiBase: string) =>
    (v2Enabled() && v2FileUrl(id)) || legacy.getUserBookFileUrl(id, apiBase),
}
