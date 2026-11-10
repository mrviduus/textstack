import { readIdSet, rekeyIds, updateIdSet } from './declinedDownloads'

/**
 * Uploads the server answered 404 for (#1174). The detail screen learns it once, online; without a
 * record the next offline moment (library tab, a reload that fails as offline) shows the cached
 * copy as a live book again.
 *
 * A mark, not a deletion: the bytes stay until the reader removes them (#1164). And not final: a
 * later successful load of the book clears it, as do Remove download and the orphan sweep.
 */
const KEY = 'offline:deletedOnServer'

export async function listDeletedOnServer(): Promise<Set<string>> {
  return readIdSet(KEY)
}

export async function isDeletedOnServer(bookId: string): Promise<boolean> {
  return (await readIdSet(KEY)).has(bookId)
}

export async function markDeletedOnServer(bookId: string): Promise<void> {
  await updateIdSet(KEY, ids => (ids.has(bookId) ? null : ids.add(bookId)))
}

/** The server showed these books again, or the reader removed the local copy. */
export async function clearDeletedOnServer(bookIds: string[]): Promise<void> {
  // filter, not some: every id must be deleted, not just the first hit.
  await updateIdSet(KEY, ids => (bookIds.filter(id => ids.delete(id)).length > 0 ? ids : null))
}

/** V2 guest → account merge: same re-key as declined downloads. */
export async function rekeyDeletedOnServer(books: Record<string, string>): Promise<void> {
  await updateIdSet(KEY, rekeyIds(books))
}

/**
 * What the book screen shows when `getUserBook` failed. A confirmed 404 is `notfound`; so is a book
 * the server already said is gone while offline. Online, a tombstoned book's other failures (500,
 * 401) say `failed` so Retry can find out, never the cached copy as live.
 */
export function failedLoadView(input: {
  notFound: boolean
  tombstoned: boolean
  hasCopy: boolean
  offline: boolean
}): 'notfound' | 'cached' | 'offline' | 'failed' {
  if (input.notFound) return 'notfound'
  if (input.tombstoned) return input.offline ? 'notfound' : 'failed'
  if (input.hasCopy) return 'cached'
  return input.offline ? 'offline' : 'failed'
}
