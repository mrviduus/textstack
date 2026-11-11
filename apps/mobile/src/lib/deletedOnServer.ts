import { readIdSet, rekeyIds, updateIdSet } from './declinedDownloads'

/**
 * Uploads the server answered 404 for (#1174). The detail screen learns it once, online; without a
 * record the next offline moment (library tab, a reload that fails as offline) shows the cached
 * copy as a live book again.
 *
 * Also learned from a successful library listing that no longer has a local copy (#1193 item 3): the
 * Library's online load on any network, and the Wi-Fi sweep (`markUnlistedLeftovers`, only copies
 * from the store that listed: `chooseNewlyDeleted`).
 *
 * A mark, not a deletion: the bytes stay until the reader removes them (#1164) — from the book's
 * not-found screen or the Library's deleted-books row — and are off the 2 GB budget meanwhile
 * (`withoutKeptDeleted`). And not final: a later successful load of
 * the book or an online library list that has it clears it, as does Remove download. Known source
 * of a false mark: with the V2 probe answering off, the legacy `/me/books/{id}` 404s for a V2-only
 * book; the next online library load heals it.
 */
const KEY = 'offline:deletedOnServer'

export async function listDeletedOnServer(): Promise<Set<string>> {
  return readIdSet(KEY)
}

/** Queued behind pending marks and clears, so it never reads a mark a clear has already been asked to drop. */
export async function isDeletedOnServer(bookId: string): Promise<boolean> {
  let has = false
  await updateIdSet(KEY, ids => { has = ids.has(bookId); return null })
  return has
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

/** Sign-out: the marks are one account's books and do not carry into the next sign-in (#1192). */
export async function forgetDeletedOnServer(): Promise<void> {
  await updateIdSet(KEY, ids => (ids.size > 0 ? new Set() : null))
}

/**
 * Marked books whose rows or original are still on this device, minus any the library currently
 * lists (a list that has a book outranks a mark not yet cleared). What the Library's
 * deleted-books row counts and removes (#1193).
 */
export function deletedStillOnDevice(
  marked: ReadonlySet<string>,
  onDevice: Iterable<string>,
  listed: ReadonlySet<string>,
): string[] {
  const out = new Set<string>()
  for (const id of onDevice) if (marked.has(id) && !listed.has(id)) out.add(id)
  return [...out]
}

/** Where a local copy came from: its rows' file id says V2 or legacy; an original file alone says neither. */
export type CopySource = 'v2' | 'legacy' | 'unknown'

/**
 * The store a library listing came from. `userBooksApi.getUserBooks` is V2 or legacy by the probe;
 * `v2Before` is the probe answer that call used, `v2After` the one after it returned. `null` when it
 * moved in between: the source is then unknown and nothing may be marked from it.
 */
export function listingSource(v2Before: boolean, v2After: boolean): 'v2' | 'legacy' | null {
  if (v2Before !== v2After) return null
  return v2Before ? 'v2' : 'legacy'
}

/**
 * Local copies a successful listing says are gone, to mark (#1193). Only copies from the store the
 * listing came from: a legacy listing (probe off or unreached) lacks every V2-only book, and a V2
 * listing may lack legacy ones, so either would mark live books. An original with no rows has no
 * known source and is never marked from a listing. Already-marked ids are left out, so a sweep that
 * finds nothing new does nothing.
 */
export function chooseNewlyDeleted(input: {
  local: ReadonlyMap<string, CopySource>
  listed: ReadonlySet<string>
  from: 'v2' | 'legacy' | null
  marked: ReadonlySet<string>
}): string[] {
  const out: string[] = []
  for (const [id, source] of input.local) {
    if (source === input.from && !input.listed.has(id) && !input.marked.has(id)) out.push(id)
  }
  return out
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
