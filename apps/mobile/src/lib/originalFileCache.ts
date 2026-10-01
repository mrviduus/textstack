import { Platform } from 'react-native'
import { API_URL, freshAccessToken } from './api'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  CACHE_BUDGET_BYTES,
  ORIGINALS_DIR,
  PART_SUFFIX,
  chooseEvictions,
  originalFileName,
  type CacheEntry,
  type OriginalFormat,
} from './originalFilePolicy'

/**
 * The reader's own uploaded file, kept on the device.
 *
 * **Why this exists.** Offline, a PDF upload used to be substituted with its
 * extracted text, because the Original-layout viewer streams the file with
 * Range requests and a Bearer token and there was no offline form of that. The
 * substitution was worse than it sounds: ADR-012 also dropped inline image
 * extraction ("the PDF renders its own images"), which is true only while the
 * PDF is being rendered. Offline it is not, so the reader got text with the
 * figures removed — from books chosen for being full of figures.
 *
 * Every reader in the category stores the file. Streaming a document
 * page-by-page is what you do when you are deliberately NOT giving someone the
 * file; here the reader uploaded it themselves.
 *
 * **Where.** `Paths.document`, not `Paths.cache`: the OS evicts the cache
 * directory under pressure, and a book the reader explicitly asked to keep is
 * not a cache entry. It is deleted when they remove the download, and on sign
 * out with the rest of that account's private material.
 */

/** Smaller than any real document: a PDF's header plus trailer alone exceeds
 *  this. A non-2xx body can still land as a written file, so size is the only
 *  honest check available without hashing twenty megabytes on the device. */
const MIN_PLAUSIBLE_BYTES = 1024

export type { OriginalFormat }

export type OriginalDownloadOutcome =
  | { status: 'downloaded'; uri: string; bytes: number }
  /** No usable session — signed out, or a refresh that failed. */
  | { status: 'unauthorized' }
  /** Reached the server, got no file: deleted, taken down, or not this owner's. */
  | { status: 'notfound' }
  | { status: 'failed' }

/** Native only. Required lazily so the web bundle (which
 *  the mobile e2e suite runs against) never pulls a filesystem module in. */
function fs() {
  return require('expo-file-system') as typeof import('expo-file-system')
}

function originalsDirectory() {
  const { Directory, Paths } = fs()
  return new Directory(Paths.document, ORIGINALS_DIR)
}

/** The local file for an upload, whether or not it has been downloaded. */
function originalFile(bookId: string, format: OriginalFormat) {
  const { File } = fs()
  return new File(originalsDirectory(), originalFileName(bookId, format))
}

/**
 * The `file://` URI of a downloaded original, or null.
 *
 * Null covers every reason equally — never downloaded, removed, evicted,
 * truncated — because the caller's next move is the same in all of them: fall
 * back to the network, or to the extracted text if there is no network either.
 */
export async function getCachedOriginalUri(
  bookId: string,
  format: OriginalFormat,
): Promise<string | null> {
  if (Platform.OS === 'web') return null
  try {
    const file = originalFile(bookId, format)
    if (!file.exists) return null
    return (file.size ?? 0) >= MIN_PLAUSIBLE_BYTES ? file.uri : null
  } catch (err) {
    console.warn('[originals] lookup failed:', err)
    return null
  }
}

/**
 * Download one upload's original to the device.
 *
 * ponytail: no byte progress and no mid-file cancel — `File.downloadFileAsync`
 * offers neither, and the API that does (`expo-file-system/legacy`'s
 * `createDownloadResumable`) is the deprecated subpath that already fails
 * silently in `useTts.ts` and is a candidate for removal in SDK 56. Trading a
 * known-fragile dependency for a progress bar is the wrong way round. The UI
 * shows an indeterminate state for this step. Revisit if the modern API gains
 * progress, or if a reader on a slow link reports it.
 */
export async function downloadOriginal(
  bookId: string,
  format: OriginalFormat,
): Promise<OriginalDownloadOutcome> {
  if (Platform.OS === 'web') return { status: 'failed' }
  // One download per book at a time. Two of them share a `.part` path, and the
  // second one's opening `delete()` removes the file the first is still
  // streaming into — whichever finishes last renames a truncated document onto
  // the real name, where it clears the size floor and opens as garbage. A
  // second tap now joins the first instead of racing it.
  const inFlight = downloadsInFlight.get(bookId)
  if (inFlight) return inFlight
  const run = downloadOriginalOnce(bookId, format)
  downloadsInFlight.set(bookId, run)
  try {
    return await run
  } finally {
    downloadsInFlight.delete(bookId)
  }
}

const downloadsInFlight = new Map<string, Promise<OriginalDownloadOutcome>>()

async function downloadOriginalOnce(
  bookId: string,
  format: OriginalFormat,
): Promise<OriginalDownloadOutcome> {

  const token = await freshAccessToken()
  if (!token) return { status: 'unauthorized' }

  const { File } = fs()
  let dir: ReturnType<typeof originalsDirectory>
  let name: string
  try {
    // `originalFileName` throws on an id that could escape the directory. Every
    // other caller wraps it; this one must too, or the rejection travels out
    // through `startUserBookDownload` into an onPress handler.
    name = originalFileName(bookId, format)
    dir = originalsDirectory()
    if (!dir.exists) dir.create({ intermediates: true })
  } catch (err) {
    console.warn('[originals] could not prepare the directory:', err)
    return { status: 'failed' }
  }

  // Into a sibling temp name first, renamed on success. A download killed
  // halfway otherwise leaves a truncated file that `getCachedOriginalUri` would
  // accept as long as it cleared the size floor — a book that opens to garbage
  // is worse than one that opens over the network.
  const destination = new File(dir, `${name}${PART_SUFFIX}`)
  try { if (destination.exists) destination.delete() } catch { /* best effort */ }

  let downloaded: InstanceType<typeof File>
  try {
    downloaded = await File.downloadFileAsync(
      `${API_URL}/me/books/${bookId}/file`,
      destination,
      { headers: { Authorization: `Bearer ${token}` }, idempotent: true },
    )
  } catch (err) {
    console.warn('[originals] download failed:', err)
    try { if (destination.exists) destination.delete() } catch { /* best effort */ }
    return { status: 'failed' }
  }

  let bytes = 0
  try { bytes = downloaded.size ?? 0 } catch { bytes = 0 }
  if (bytes < MIN_PLAUSIBLE_BYTES) {
    // Not the 404 path: `downloadFileAsync` rejects on any non-2xx and writes
    // nothing, so a missing book arrives at the `catch` above as `failed`.
    // What this catches is a file that downloaded successfully and is too small
    // to be a document — a truncated response, or an empty stored file.
    try { downloaded.delete() } catch { /* best effort */ }
    return { status: 'notfound' }
  }

  const final = originalFile(bookId, format)
  try {
    if (final.exists) final.delete()
    downloaded.move(final)
  } catch (err) {
    console.warn('[originals] could not put the file in place:', err)
    try { downloaded.delete() } catch { /* best effort */ }
    return { status: 'failed' }
  }

  await touchOriginal(bookId)
  return { status: 'downloaded', uri: final.uri, bytes }
}

/** Remove one upload's original. Safe to call when there is nothing there. */
export async function deleteOriginal(bookId: string, format: OriginalFormat): Promise<void> {
  if (Platform.OS === 'web') return
  try {
    const file = originalFile(bookId, format)
    if (file.exists) file.delete()
    const part = new (fs().File)(originalsDirectory(), `${originalFileName(bookId, format)}${PART_SUFFIX}`)
    if (part.exists) part.delete()
    // And its place in the eviction order. `evictToBudget` prunes the index for
    // the files it deletes itself; this path did not, so every book removed by
    // hand left a timestamp behind for the life of the install.
    const lastUsed = await readLastUsed()
    if (bookId in lastUsed) {
      delete lastUsed[bookId]
      await AsyncStorage.setItem(LAST_USED_KEY, JSON.stringify(lastUsed))
    }
  } catch (err) {
    console.warn('[originals] delete failed:', err)
  }
}

/**
 * Remove every stored original.
 *
 * Called from the sign-out wipe beside `clearCachedUserBooks()`. An upload is
 * one account's private file and must not be left on disk for whoever signs in
 * next — and unlike the SQLite rows, this one is a real file a file manager can
 * see.
 */
export async function deleteAllOriginals(): Promise<void> {
  if (Platform.OS === 'web') return
  try {
    await AsyncStorage.removeItem(LAST_USED_KEY).catch(() => {})
    const dir = originalsDirectory()
    if (dir.exists) dir.delete()
  } catch (err) {
    console.warn('[originals] wipe failed:', err)
  }
}

/** Bytes currently held by stored originals. The storage screen in the next
 *  slice reports it; the eviction budget will spend it. */
export async function originalsTotalBytes(): Promise<number> {
  if (Platform.OS === 'web') return 0
  try {
    const dir = originalsDirectory()
    if (!dir.exists) return 0
    let total = 0
    for (const entry of dir.list()) {
      // Half-downloads are bytes no reader can open. Counting them inflates the
      // figure the storage screen reports and the budget eviction will spend.
      if (entry.name?.endsWith(PART_SUFFIX)) continue
      const size = (entry as { size?: number | null }).size
      if (typeof size === 'number') total += size
    }
    return total
  } catch (err) {
    console.warn('[originals] size scan failed:', err)
    return 0
  }
}

/**
 * When each stored original was last opened.
 *
 * Kept in AsyncStorage rather than on the files themselves. The modern
 * `expo-file-system` cannot touch an mtime — the trick `EdgeTtsService` uses
 * server-side — and a file's own timestamp is when it was DOWNLOADED, which
 * would evict the book someone reads every day in favour of one they grabbed
 * yesterday and never opened. Adding a column to the SQLite meta was the other
 * option and is worse: the schema is `CREATE TABLE IF NOT EXISTS` with no
 * migration path, so a new column silently never appears on an install that
 * already has the table.
 */
const LAST_USED_KEY = 'originals:lastUsed'

async function readLastUsed(): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(LAST_USED_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    // A corrupt index costs eviction order, not correctness — start over.
    return {}
  }
}

/** Record that this book was just opened from disk. Cheap enough to call on
 *  every open; the map holds one number per downloaded book. */
export async function touchOriginal(bookId: string): Promise<void> {
  if (Platform.OS === 'web') return
  try {
    const map = await readLastUsed()
    map[bookId] = Date.now()
    await AsyncStorage.setItem(LAST_USED_KEY, JSON.stringify(map))
  } catch (err) {
    console.warn('[originals] could not record use:', err)
  }
}

/**
 * Delete the least recently opened originals until the cache is under budget.
 *
 * `protectedBookIds` is honoured absolutely — see `chooseEvictions`. Returns
 * the number of bytes freed, which is 0 both when nothing needed doing and when
 * nothing COULD be done because everything over budget is protected. The caller
 * must not read 0 as a failure.
 */
export async function evictToBudget(
  protectedBookIds: ReadonlySet<string> = new Set(),
  budgetBytes: number = CACHE_BUDGET_BYTES,
): Promise<number> {
  if (Platform.OS === 'web') return 0
  try {
    const dir = originalsDirectory()
    if (!dir.exists) return 0

    const lastUsed = await readLastUsed()
    const entries: CacheEntry[] = []
    for (const item of dir.list()) {
      const name = item.name
      if (!name || name.endsWith(PART_SUFFIX)) continue
      const bytes = (item as { size?: number | null }).size
      if (typeof bytes !== 'number') continue
      const bookId = name.replace(/\.(pdf|epub)$/i, '')
      entries.push({ name, bookId, bytes, lastUsedAt: lastUsed[bookId] ?? 0 })
    }

    const doomed = chooseEvictions(entries, budgetBytes, protectedBookIds)
    let freed = 0
    for (const entry of doomed) {
      try {
        const file = new (fs().File)(dir, entry.name)
        if (file.exists) file.delete()
        freed += entry.bytes
        delete lastUsed[entry.bookId]
      } catch (err) {
        console.warn(`[originals] could not evict ${entry.name}:`, err)
      }
    }
    if (doomed.length > 0) {
      await AsyncStorage.setItem(LAST_USED_KEY, JSON.stringify(lastUsed))
      console.warn(`[originals] evicted ${doomed.length} file(s), ${freed} bytes, to stay under budget`)
    }
    return freed
  } catch (err) {
    console.warn('[originals] eviction failed:', err)
    return 0
  }
}

/** Ids of uploads whose original is on this device. One directory listing
 *  instead of a filesystem probe per book — the automatic sweep asks this for
 *  the whole library at once. */
export async function listStoredOriginalIds(): Promise<Set<string>> {
  if (Platform.OS === 'web') return new Set()
  try {
    const dir = originalsDirectory()
    if (!dir.exists) return new Set()
    const ids = new Set<string>()
    for (const entry of dir.list()) {
      const name = entry.name
      if (!name || name.endsWith(PART_SUFFIX)) continue
      ids.add(name.replace(/\.(pdf|epub)$/i, ''))
    }
    return ids
  } catch (err) {
    console.warn('[originals] listing failed:', err)
    return new Set()
  }
}
