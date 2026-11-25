// A book's file fetched to the device: the reader's on-demand download, and the same for the Library and the
// book page (#1522): "on this device" = the retained copy under <documents>/v2/books/ (hostStorage.ts).
import { Platform } from 'react-native'
import { File } from 'expo-file-system'
import { APP_HEADERS, freshAccessToken } from '../api'
import { deviceUploadIo, sha256Of } from '../sync'
import { bookFile, intactBook } from './hostStorage'
import { deviceLocalLibrary, filesRoot, makeFileDirs } from './deviceLibrary'
import { downloadBook, removeLocalBook } from './sync'
import { userBooksApi } from '../userBooksApi'

/** `name` under <documents>/v2/ (`filesRoot`, shared with the wipe and the measure), e.g. `books/<sha256>.epub`. */
export const hostFile = (name: string) => new File(filesRoot(), ...name.split('/'))

/** `name` under the root deleted, when it is there: the one device file removal (the reader's host, Delete Book, a download). */
export const removeHostFile = (name: string) => {
  const file = hostFile(name)
  if (file.exists) file.delete()
}

/** Bytes of `name` under the root; null when it is not there or cannot be read (`HostFiles.size`). */
export const hostFileSize = (name: string): number | null => {
  try {
    return hostFile(name).size ?? null
  } catch {
    return null
  }
}

/** Whether the retained copy of these bytes can be opened: there and not empty (#1602). */
export const bookFileIntact = (sha256: string) => intactBook({ exists: (name) => hostFile(name).exists, size: hostFileSize }, sha256)

/**
 * A download's time in its staged name, one apart from the last: two downloads in one millisecond (the reader's and a
 * Download, #1526) stage apart, in the one shape the book server serves (bookOrigin.mjs `BOOK_PATH`).
 */
let lastStaged = 0

/** Download on demand: into staging, checked against the sha256, then the retained copy (an earlier process's leftovers are swept on start). */
export const downloadIo = {
  async fetch(url: string, sha256: string) {
    const token = await freshAccessToken()
    const staged = `staging/dl-${(lastStaged = Math.max(Date.now(), lastStaged + 1))}.epub`
    const dest = hostFile(staged)
    const file = await File.downloadFileAsync(url, dest, { headers: { ...APP_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, idempotent: true })
      .catch((e) => {
        // A failed download (a full disk) leaves no partial file, like a failed pick.
        try { if (dest.exists) dest.delete() } catch { /* swept on a later start */ }
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
  remove: (sha256: string) => removeHostFile(bookFile(sha256)),
  intact: bookFileIntact,
}

/** The ids of the books whose file is on this device. Empty on web (no local library there). */
export async function booksOnDevice(): Promise<Set<string>> {
  if (Platform.OS === 'web') return new Set()
  return new Set((await deviceLocalLibrary().books()).filter((b) => b.local).map((b) => b.id))
}

/**
 * The book's retained file (the Download, `books/<sha256>.epub` whatever its format): its `file://` URI and the
 * format the device knows it by (null: not known). Null: not on this device.
 */
export async function retainedFile(bookId: string): Promise<{ uri: string; format: string | null } | null> {
  if (Platform.OS === 'web') return null
  const here = (await deviceLocalLibrary().books()).find((b) => b.id === bookId && b.local)
  const file = here ? hostFile(bookFile(here.sha256)) : null
  return file?.exists ? { uri: file.uri, format: here!.format ?? null } : null
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

/**
 * #1189: Delete Book: off this device too (rows, queued writes, the retained file), offline and with no account; the
 * server's removal goes with the next pass (`sync`). Web (no local library): the server's removal only.
 */
export async function deleteBook(bookId: string, refresh: () => Promise<unknown>, sync: () => void): Promise<void> {
  if (Platform.OS === 'web') return userBooksApi.deleteUserBook(bookId)
  await removeLocalBook(deviceLocalLibrary(), { remove: removeHostFile }, bookId, refresh, sync)
}
