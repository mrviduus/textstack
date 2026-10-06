import { openOfflineDb } from './offlineDb'

export interface Bookmark {
  id: string
  /** Catalog: the book slug. Upload: the UserBook id. */
  bookId: string
  chapterSlug: string
  chapterTitle: string
  chapterId?: string
  /**
   * 1-based PDF page for an Original-layout page bookmark (locator `page:<N>`).
   * Null/undefined for ordinary chapter bookmarks.
   */
  page?: number | null
  createdAt: number
  /** Whose row: a user id, or 'anon' (no session). Absent on rows written before
   *  the offline queue — those are claimed on first read (bookmarkSync.claimRow). */
  owner?: string
  /** pending: not on the server yet (or re-added while its delete was in flight). */
  syncStatus?: 'pending' | 'synced'
  /** Tombstone: deleted here, server delete not confirmed. Hidden from the UI. */
  deleted?: boolean
}

const STORE = 'bookmarks'

/**
 * Read-modify-write one book's rows in a single IndexedDB transaction, so a
 * concurrent sync step or user action lands entirely before or after it — never
 * between its read and its write. `fn` must be synchronous.
 */
export async function mutateBookmarks<T>(
  bookId: string,
  fn: (rows: Bookmark[]) => { put?: Bookmark[]; del?: string[]; result: T },
): Promise<T> {
  const db = await openOfflineDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    let result: T
    const req = store.index('bookId').getAll(bookId)
    req.onsuccess = () => {
      const out = fn(req.result as Bookmark[])
      result = out.result
      for (const b of out.put ?? []) store.put(b)
      for (const id of out.del ?? []) store.delete(id)
    }
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}
