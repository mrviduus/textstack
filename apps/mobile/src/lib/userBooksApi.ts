/**
 * The user-book API the screens and hooks call: V2 (#1025 M2.7; the only store since M6), mapped onto the
 * shared shapes. Open, read, progress, finish and delete.
 */
import {
  getV2UserBooks, getV2UserBook, getV2UserBookChapter, removeV2Book, v2FileUrl,
  readV2Progress, saveV2Progress, completeV2Book, uncompleteV2Book,
} from './v2'

export const userBooksApi = {
  getUserBooks: getV2UserBooks,
  getUserBook: getV2UserBook,
  getUserBookChapter: getV2UserBookChapter,
  deleteUserBook: removeV2Book,
  getUserBookProgress: readV2Progress,
  /** The revision rule decides (`WriteOutcome`). */
  updateUserBookProgress: saveV2Progress,
  markUserBookComplete: completeV2Book,
  unmarkUserBookComplete: uncompleteV2Book,
  /** '' while the book's file is not known yet: callers treat it as no URL. */
  getUserBookFileUrl: v2FileUrl,
}
