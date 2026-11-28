// A book's file fetched to the device: the reader's on-demand download, and the same for the Library and the
// book page (#1522): "on this device" = the retained copy under <data>/v2/books/ (hostStorage.ts).
// A copy of the Expo app's deviceDownload.ts over @capacitor/filesystem: every file call is async here.
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { uuid } from './native'
import { APP_HEADERS, freshAccessToken } from './api'
import { deviceUploadIo, resetSince, sha256Of } from './syncClient'
import { bookFile, createHostStorage, intactBook, type HostFiles, type HostStorage } from './hostStorage'
import { deviceLocalLibrary, FILES_ROOT, makeFileDirs, sweepStaging } from './deviceLibrary'
import { downloadBook, removeLocalBook } from './librarySync'

/** `name` under <data>/v2/ (`FILES_ROOT`, shared with the wipe and the measure), e.g. `books/<sha256>.epub`. */
const hostFile = (name: string) => ({ path: `${FILES_ROOT}/${name}`, directory: Directory.Data })

/** The plugin's "does not exist" (FilesystemErrors.kt `doesNotExist`): the one stat error that means absent. */
const MISSING = 'OS-PLUG-FILE-0008'
const isMissing = (e: unknown) => (e as { code?: string } | null)?.code === MISSING

/** Whether `name` is there. Any stat error other than "does not exist" is thrown, never read as absent. */
const hostFileExists = (name: string) =>
  Filesystem.stat(hostFile(name)).then(() => true, (e: unknown) => { if (isMissing(e)) return false; throw e })

/** `name` under the root deleted, when it is there: the one device file removal (the reader's host, Delete Book, a download). */
export const removeHostFile = async (name: string) => {
  // deleteFile fails on a missing file: only a file still there after it is a failure.
  await Filesystem.deleteFile(hostFile(name)).catch(async (e: unknown) => { if (await hostFileExists(name)) throw e })
}

/** Bytes of `name` under the root; null when it is not there or cannot be read (`HostFiles.size`). */
export const hostFileSize = async (name: string): Promise<number | null> => {
  try {
    return (await Filesystem.stat(hostFile(name))).size ?? null
  } catch {
    return null
  }
}

const rename = (from: string, to: string) => Filesystem.rename({ from: hostFile(from).path, to: hostFile(to).path, directory: Directory.Data })

/**
 * Overwrites `to`, and a failure never loses it. The rename is tried first. When it fails and the target is there
 * (a rename that does not overwrite), the target goes aside, the rename is tried again, and the old copy is deleted;
 * a second failure puts the old copy back.
 */
const moveHostFile = async (from: string, to: string) => {
  await rename(from, to).catch(async (e: unknown) => {
    if (!(await hostFileExists(to))) throw e
    const aside = `${to}.old-${Date.now()}`
    await rename(to, aside)
    try {
      await rename(from, to)
    } catch (again) {
      await rename(aside, to).catch(() => { /* the old copy stays under its aside name */ })
      throw again
    }
    await removeHostFile(aside).catch(() => { /* only space */ })
  })
}

/** The reader host's files under the root (hostStorage.ts `HostFiles`). */
function deviceFiles(): HostFiles {
  // Anything an earlier process staged and never finished; this process's own (a Download, an upload) stay (#1526).
  // Started here, as the original does; every file call waits for it. A failure is that call's error, and the
  // next call tries again.
  let ready: Promise<void> | null = null
  const prepared = () => (ready ??= sweepStaging().then(makeFileDirs).catch((e: unknown) => {
    ready = null
    throw e
  }))
  prepared().catch(() => { /* the next file call tries again and gets the error */ })
  const after = <A extends unknown[], T>(fn: (...a: A) => Promise<T>) => async (...a: A) => {
    await prepared()
    return fn(...a)
  }
  return {
    read: after(async (name: string) =>
      (await hostFileExists(name)) ? ((await Filesystem.readFile({ ...hostFile(name), encoding: Encoding.UTF8 })).data as string) : null),
    move: after(moveHostFile),
    exists: after(hostFileExists),
    size: after(hostFileSize),
    remove: after(removeHostFile),
    // A picker's content:// (or any absolute) uri: `from` with no directory.
    copyIn: after(async (uri: string, to: string) => {
      await Filesystem.copy({ from: uri, to: hostFile(to).path, toDirectory: Directory.Data })
    }),
  }
}

// One storage for the process, so every read and write goes through its one queue.
let storage: HostStorage | null = null
export const readerStorage = () => (storage ??= createHostStorage(deviceFiles(), uuid.v4, deviceLocalLibrary(), resetSince))

/** Whether the retained copy of these bytes can be opened: there and not empty (#1602). */
export const bookFileIntact = (sha256: string) => intactBook({ exists: hostFileExists, size: hostFileSize }, sha256)

/**
 * A download's time in its staged name, one apart from the last: two downloads in one millisecond (the reader's and a
 * Download, #1526) stage apart, in the one shape the book server serves (bookOrigin.mjs `BOOK_PATH`).
 */
let lastStaged = 0

/** Download on demand: into staging, checked against the sha256, then the retained copy (an earlier process's leftovers are swept on start). */
export const downloadIo = {
  async fetch(url: string, sha256: string) {
    // A fresh install or a wipe may have no staging/ yet (the reader host makes it async).
    await makeFileDirs()
    const token = await freshAccessToken()
    const staged = `staging/dl-${(lastStaged = Math.max(Date.now(), lastStaged + 1))}.epub`
    // ponytail: `downloadFile` is deprecated for @capacitor/file-transfer (not installed); move to its
    // `downloadFile` when this plugin drops it.
    await Filesystem.downloadFile({ url, ...hostFile(staged), recursive: true, headers: { ...APP_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
      .catch(async (e: unknown) => {
        // A failed download (a full disk) leaves no partial file, like a failed pick.
        await removeHostFile(staged).catch(() => { /* swept on a later start */ })
        throw e
      })
    const { uri } = await Filesystem.getUri(hostFile(staged))
    const source = await deviceUploadIo(() => false).open(uri)
    const actual = await sha256Of(source, () => new Promise((r) => setTimeout(r, 0))).finally(() => source.close())
    if (actual !== sha256) {
      await removeHostFile(staged)
      throw new Error('downloaded bytes do not match the book')
    }
    return staged
  },
  retain: async (staged: string, sha256: string) => {
    await makeFileDirs()
    await moveHostFile(staged, bookFile(sha256))
  },
  dropUnheld: (sha256: string) => readerStorage().dropUnheld(sha256),
  intact: bookFileIntact,
}

/** The ids of the books whose file is on this device. */
export async function booksOnDevice(): Promise<Set<string>> {
  return new Set((await deviceLocalLibrary().books()).filter((b) => b.local).map((b) => b.id))
}

/**
 * The book's retained file (the Download, `books/<sha256>.epub` whatever its format): its `file://` URI and the
 * format the device knows it by (null: not known). Null: not on this device.
 */
export async function retainedFile(bookId: string): Promise<{ uri: string; format: string | null } | null> {
  const here = (await deviceLocalLibrary().books()).find((b) => b.id === bookId && b.local)
  if (!here || !(await hostFileExists(bookFile(here.sha256)))) return null
  return { uri: (await Filesystem.getUri(hostFile(bookFile(here.sha256)))).uri, format: here.format ?? null }
}

/**
 * The book's file retained here, as opening it would (`downloadBook`). `pull` runs first when the device's
 * library does not know the book's server file yet (a sync pass). Resolves to whether the file is here now.
 */
export async function retainBook(bookId: string, pull: () => Promise<unknown>): Promise<boolean> {
  const lib = deviceLocalLibrary()
  if (!(await lib.book(bookId))?.server_file_id) await pull()
  await makeFileDirs()
  await downloadBook(lib, bookId, downloadIo)
  return (await booksOnDevice()).has(bookId)
}

/**
 * #1189: Delete Book: off this device too (rows, queued writes, the retained file), offline and with no account; the
 * server's removal goes with the next pass (`sync`).
 */
export async function deleteBook(bookId: string, refresh: () => Promise<unknown>, sync: () => void): Promise<void> {
  await removeLocalBook(deviceLocalLibrary(), { remove: removeHostFile }, bookId, refresh, sync)
}
