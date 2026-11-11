import { hasAnyUserBookCache, listUserBookCaches } from './offlineDb'
import { listStoredOriginalIds } from './originalFileCache'
import { chooseNewlyDeleted, listDeletedOnServer, markDeletedOnServer, type CopySource } from './deletedOnServer'

/**
 * One definition of "this upload is still on the device" (#1174, #1193): SQLite rows, partial
 * included (chapters cached while reading online with no meta row), or the stored original alone.
 * The book screen's Remove, the Library's deleted-books row and the deleted-on-server marking all
 * read it.
 */
export async function hasLocalLeftovers(bookId: string): Promise<boolean> {
  const [rows, originals] = await Promise.all([
    hasAnyUserBookCache(bookId).catch(() => false),
    listStoredOriginalIds(),
  ])
  return rows || originals.has(bookId)
}

/** `hasLocalLeftovers` for every upload at once, with where each copy came from. */
export async function listLocalLeftovers(): Promise<Map<string, CopySource>> {
  const [rows, originals] = await Promise.all([listUserBookCaches(), listStoredOriginalIds()])
  const out = new Map<string, CopySource>()
  for (const [id, v2] of rows) out.set(id, v2 ? 'v2' : 'legacy')
  for (const id of originals) if (!out.has(id)) out.set(id, 'unknown')
  return out
}

/**
 * Mark what a successful listing no longer has (#1193 item 3). Bytes stay (#1164). `stale` is the
 * caller's V2-reset check (#1191): a reset mid-way stops it. Returns the ids it newly marked.
 */
export async function markUnlistedLeftovers(
  listed: ReadonlySet<string>,
  from: 'v2' | 'legacy' | null,
  stale: () => boolean,
): Promise<string[]> {
  if (!from || stale()) return []
  const [local, marked] = await Promise.all([listLocalLeftovers(), listDeletedOnServer()])
  const done: string[] = []
  for (const id of chooseNewlyDeleted({ local, listed, from, marked })) {
    if (stale()) break
    await markDeletedOnServer(id)
    done.push(id)
  }
  return done
}
