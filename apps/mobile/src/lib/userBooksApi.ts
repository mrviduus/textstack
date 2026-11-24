/**
 * The user-book API the screens and hooks call: V2 (#1025 M2.7; the only store since M6), mapped onto the
 * shared shapes. Open, read progress, finish and delete.
 */
import {
  getUserBooks, getUserBook, removeBook, originalFileUrl,
  readProgress, completeBook, uncompleteBook,
} from './sync'

export const userBooksApi = {
  getUserBooks,
  getUserBook,
  deleteUserBook: removeBook,
  getUserBookProgress: readProgress,
  markUserBookComplete: completeBook,
  unmarkUserBookComplete: uncompleteBook,
  /** '' while the book's file is not known yet: callers treat it as no URL. */
  getUserBookFileUrl: originalFileUrl,
}
