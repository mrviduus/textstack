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

const read = () => readIdSet(KEY)
const write = (ids: Set<string>) => writeIdSet(KEY, ids)

export async function listDeclinedDownloads(): Promise<Set<string>> {
  return read()
}

/** The reader removed this download. Stop fetching it automatically. */
export async function declineDownload(bookId: string): Promise<void> {
  const ids = await read()
  if (ids.has(bookId)) return
  ids.add(bookId)
  await write(ids)
}

/** The reader asked for it again — by pressing Download, which is as clear a
 *  statement as removing it was. */
export async function undeclineDownload(bookId: string): Promise<void> {
  const ids = await read()
  if (!ids.delete(bookId)) return
  await write(ids)
}

/** V2 guest → account merge: a declined guest book stays declined under the account's id. */
export async function rekeyDeclinedDownloads(books: Record<string, string>): Promise<void> {
  const ids = await read()
  if (![...ids].some(id => books[id])) return
  await write(new Set([...ids].map(id => books[id] ?? id)))
}
