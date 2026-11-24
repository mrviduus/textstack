// A book's file fetched to the device: the reader's on-demand download, and the same for the Library and the
// book page (#1522): "on this device" = the retained copy under <documents>/v2/books/ (hostStorage.ts).
import { Platform } from 'react-native'
import { File } from 'expo-file-system'
import { APP_HEADERS, freshAccessToken } from '../api'
import { deviceUploadIo, sha256Of } from '../sync'
import { bookFile } from './hostStorage'
import { deviceLocalLibrary, filesRoot, makeFileDirs } from './deviceLibrary'
import { downloadBook } from './sync'

/** `name` under <documents>/v2/ (`filesRoot`, shared with the wipe and the measure), e.g. `books/<sha256>.epub`. */
export const hostFile = (name: string) => new File(filesRoot(), ...name.split('/'))

/** Download on demand: into staging, checked against the sha256, then the retained copy (`staging/` is cleared on start). */
export const downloadIo = {
  async fetch(url: string, sha256: string) {
    const token = await freshAccessToken()
    const staged = `staging/dl-${Date.now()}.epub`
    const dest = hostFile(staged)
    const file = await File.downloadFileAsync(url, dest, { headers: { ...APP_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, idempotent: true })
      .catch((e) => {
        // A failed download (a full disk) leaves no partial file, like a failed pick.
        try { if (dest.exists) dest.delete() } catch { /* staging/ is cleared on start */ }
        throw e
      })
    const source = deviceUploadIo(() => false).open(file.uri)
    const actual = await sha256Of(source, () => new Promise((r) => setTimeout(r, 0))).finally(() => source.close())
    if (actual !== sha256) {
      file.delete()
      throw new Error('downloaded bytes do not match the book')
    }
    return staged
  },
  retain: async (staged: string, sha256: string) => hostFile(staged).move(hostFile(bookFile(sha256)), { overwrite: true }),
}

/** The ids of the books whose file is on this device. Empty on web (no local library there). */
export async function booksOnDevice(): Promise<Set<string>> {
  if (Platform.OS === 'web') return new Set()
  return new Set((await deviceLocalLibrary().books()).filter((b) => b.local).map((b) => b.id))
}

/** The `file://` URI of the book's retained file (the Download, `books/<sha256>.epub`), or null: not on this device. */
export async function retainedFileUri(bookId: string): Promise<string | null> {
  if (Platform.OS === 'web') return null
  const here = (await deviceLocalLibrary().books()).find((b) => b.id === bookId && b.local)
  const file = here ? hostFile(bookFile(here.sha256)) : null
  return file?.exists ? file.uri : null
}

/**
 * The book's file retained here, as opening it would (`downloadBook`). `pull` runs first when the device's
 * library does not know the book's server file yet (a sync pass). Resolves to whether the file is here now.
 */
export async function retainBook(bookId: string, pull: () => Promise<unknown>): Promise<boolean> {
  if (Platform.OS === 'web') return false
  const lib = deviceLocalLibrary()
  if (!(await lib.book(bookId))?.server_file_id) await pull()
  makeFileDirs()
  await downloadBook(lib, bookId, downloadIo)
  return (await booksOnDevice()).has(bookId)
}
