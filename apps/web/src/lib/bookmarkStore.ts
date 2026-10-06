import { openOfflineDb } from './offlineDb'

export interface Bookmark {
  id: string
  bookId: string
  chapterSlug: string
  chapterTitle: string
  chapterId?: string // For server sync
  /**
   * 1-based PDF page for an Original-layout page bookmark (locator `page:<N>`).
   * Null/undefined for ordinary chapter bookmarks.
   */
  page?: number | null
  createdAt: number
  /** Not on the server yet. Absent on rows written before the flag: a GUID id
   *  came from the server, anything else is local-only (see isPendingBookmark). */
  syncStatus?: 'pending' | 'synced'
  /** Tombstone: deleted locally, server delete not confirmed. Hidden from the UI. */
  deleted?: boolean
}

const STORE_NAME = 'bookmarks'

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openOfflineDb().then((db) => new Promise<T>((resolve, reject) => {
    const request = op(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME))
    request.onsuccess = () => resolve(request.result as T)
    request.onerror = () => reject(request.error)
  }))
}

export const getBookmarksForBook = (bookId: string): Promise<Bookmark[]> =>
  run<Bookmark[]>('readonly', (s) => s.index('bookId').getAll(bookId))

export const saveBookmark = (bookmark: Bookmark): Promise<void> =>
  run<void>('readwrite', (s) => s.put(bookmark))

export const deleteBookmark = (id: string): Promise<void> =>
  run<void>('readwrite', (s) => s.delete(id))
