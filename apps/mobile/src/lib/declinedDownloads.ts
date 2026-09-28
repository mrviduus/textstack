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

async function read(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : [])
  } catch {
    // A corrupt list costs one unwanted re-download, not correctness.
    return new Set()
  }
}

async function write(ids: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify([...ids]))
  } catch (err) {
    console.warn('[declined] could not record:', err)
  }
}

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
