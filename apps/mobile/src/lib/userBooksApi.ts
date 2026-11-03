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
  switched, v2Enabled, getV2UserBooks, getV2UserBook, getV2UserBookChapter, removeV2Book, v2FileUrl,
  readV2Progress, saveV2Progress, completeV2Book, uncompleteV2Book,
} from './v2'

export const userBooksApi = {
  ...legacy,
  getUserBooks: switched(getV2UserBooks, legacy.getUserBooks),
  getUserBook: switched(getV2UserBook, legacy.getUserBook),
  getUserBookChapter: switched(getV2UserBookChapter, legacy.getUserBookChapter),
  deleteUserBook: switched(removeV2Book, legacy.deleteUserBook),
  getUserBookProgress: switched(readV2Progress, legacy.getUserBookProgress),
  /** On V2 the revision rule decides (`V2WriteOutcome`); legacy answers nothing. */
  updateUserBookProgress: switched(saveV2Progress, legacy.updateUserBookProgress),
  markUserBookComplete: switched(completeV2Book, legacy.markUserBookComplete),
  unmarkUserBookComplete: switched(uncompleteV2Book, legacy.unmarkUserBookComplete),
  getUserBookBookmarks: switched(() => [], legacy.getUserBookBookmarks),
  /** '' on V2 while the book's file is not known yet: callers treat it as no URL, never a legacy route. */
  getUserBookFileUrl: (id: string, apiBase: string) =>
    (v2Enabled() ? v2FileUrl(id) : legacy.getUserBookFileUrl(id, apiBase)),
}
