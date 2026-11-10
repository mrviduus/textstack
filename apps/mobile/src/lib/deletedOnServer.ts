import { readIdSet, writeIdSet } from './declinedDownloads'

/**
 * Uploads the server answered 404 for (#1174). The detail screen learns it once, online; without a
 * record the next offline moment (library tab, a reload that fails as offline) shows the cached
 * copy as a live book again.
 *
 * A mark, not a deletion: the bytes stay until the reader removes them (#1164). And not final —
 * V2 can synthesize a 404 when a store reset cuts a pull short (`v2Book`), so any later successful
 * load of the book, or the book in an online library list, clears it.
 */
const KEY = 'offline:deletedOnServer'

export async function listDeletedOnServer(): Promise<Set<string>> {
  return readIdSet(KEY)
}

export async function isDeletedOnServer(bookId: string): Promise<boolean> {
  return (await readIdSet(KEY)).has(bookId)
}

export async function markDeletedOnServer(bookId: string): Promise<void> {
  const ids = await readIdSet(KEY)
  if (ids.has(bookId)) return
  ids.add(bookId)
  await writeIdSet(KEY, ids)
}

/** The server showed these books again, or the reader removed the local copy. */
export async function clearDeletedOnServer(bookIds: string[]): Promise<void> {
  const ids = await readIdSet(KEY)
  // filter, not some: every id must be deleted, not just the first hit.
  if (bookIds.filter(id => ids.delete(id)).length === 0) return
  await writeIdSet(KEY, ids)
}

/** V2 guest → account merge: same re-key as declined downloads. */
export async function rekeyDeletedOnServer(books: Record<string, string>): Promise<void> {
  const ids = await readIdSet(KEY)
  if (![...ids].some(id => books[id])) return
  await writeIdSet(KEY, new Set([...ids].map(id => books[id] ?? id)))
}

/**
 * What the book screen shows when `getUserBook` failed. A confirmed 404, or any failure for a book
 * the server already said is gone, is `notfound`; otherwise the cached copy if there is one.
 */
export function failedLoadView(input: {
  notFound: boolean
  tombstoned: boolean
  hasCopy: boolean
  offline: boolean
}): 'notfound' | 'cached' | 'offline' | 'failed' {
  if (input.notFound || input.tombstoned) return 'notfound'
  if (input.hasCopy) return 'cached'
  return input.offline ? 'offline' : 'failed'
}
