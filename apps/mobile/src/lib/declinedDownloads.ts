import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * Books the reader took off this device on purpose.
 *
 * The automatic sweep decides what to fetch from "is it cached?", and a removed
 * book answers no — so without this it comes back on the next Wi-Fi, along with
 * the megabytes the reader had just freed. Being overruled by your own app is
 * worse than not having the feature.
 *
 * Deliberately NOT a tombstone forever: pressing Download on the book clears
 * it, because that is the reader saying the opposite thing just as clearly.
 */
const KEY = 'offline:declined'

/** An AsyncStorage id set, shared with `deletedOnServer.ts`. */
export async function readIdSet(key: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : null
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : [])
  } catch {
    // A corrupt list reads as empty: here one unwanted re-download, for a
    // tombstone one book shown as live again until its next 404.
    return new Set()
  }
}

export async function writeIdSet(key: string, ids: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify([...ids]))
  } catch (err) {
    console.warn(`[${key}] could not record:`, err)
  }
}

const queue = new Map<string, Promise<void>>()

/**
 * Read-modify-write of one id set, one caller at a time per key: two overlapping updates would
 * otherwise both read the old set and the later write would drop the earlier one (#1174).
 * `change` returns the new set, or null to write nothing.
 */
export function updateIdSet(key: string, change: (ids: Set<string>) => Set<string> | null): Promise<void> {
  const run = (queue.get(key) ?? Promise.resolve()).then(async () => {
    const next = change(await readIdSet(key))
    if (next) await writeIdSet(key, next)
  })
  // The queue keeps a settled copy: one throwing update must not reject every later one on this key.
  queue.set(key, run.catch(() => {}))
  return run
}

export async function listDeclinedDownloads(): Promise<Set<string>> {
  return readIdSet(KEY)
}

/** The reader removed this download. Stop fetching it automatically. */
export async function declineDownload(bookId: string): Promise<void> {
  await updateIdSet(KEY, ids => (ids.has(bookId) ? null : ids.add(bookId)))
}

/** The reader asked for it again — by pressing Download, which is as clear a
 *  statement as removing it was. */
export async function undeclineDownload(bookId: string): Promise<void> {
  await updateIdSet(KEY, ids => (ids.delete(bookId) ? ids : null))
}

/** A guest's ids become the account's (V2 merge map); null when none of them is in the set. */
export const rekeyIds = (books: Record<string, string>) => (ids: Set<string>) =>
  [...ids].some(id => books[id]) ? new Set([...ids].map(id => books[id] ?? id)) : null

/** V2 guest → account merge: a declined guest book stays declined under the account's id. */
export async function rekeyDeclinedDownloads(books: Record<string, string>): Promise<void> {
  await updateIdSet(KEY, rekeyIds(books))
}

/** Sign-out: the ids are one account's books and do not carry into the next sign-in (#1192). */
export async function forgetDeclinedDownloads(): Promise<void> {
  await updateIdSet(KEY, ids => (ids.size > 0 ? new Set() : null))
}
