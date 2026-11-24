/**
 * An upload on V2 for both clients (#1121, PDD "File sync upload protocol"): hash, look the bytes up,
 * import the metadata, send the parts, complete. Each app gives its IO: the hash, the ids, one
 * part's send (XHR + `Blob.slice` on web, `readBytes` + fetch on mobile) and the progress it shows.
 */
import * as syncApi from './sync'
import type { Book, FileWrite } from './sync'
import { clip } from '../reader/textAnchor'
import { bookTitle } from '../lib/bookTitle'
import { tocForServer } from '../lib/fileToc'

/** Bytes as whole megabytes, for a quota message. */
export const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

/** A V2 upload the reader must hear about; `code` picks the message. */
export class FileUploadError extends Error {
  constructor(readonly code: 'content_mismatch' | 'quota_exceeded', readonly quota?: { used: number; limit: number }) {
    super(code === 'content_mismatch'
      ? 'The file changed while it was uploading. Pick it again.'
      : `Not enough storage: ${mb(quota?.used ?? 0)} of ${mb(quota?.limit ?? 0)} used.`)
  }
}

/**
 * A known book's bytes asked for, but the server does not hold that book's current file (removed,
 * replaced, or never pushed): nothing was imported. The caller pushes the book again first.
 */
export class UploadNotOnServer extends Error {
  constructor(readonly bookId: string) {
    super('The book is not on the server as this device knows it')
  }
}

export type ClientFormat = FileWrite['format']
const FORMATS: readonly string[] = ['epub', 'pdf', 'mobi', 'azw3', 'fb2', 'cbz']
/** The extensions a picker offers: the formats the server stores and the reader opens, plus `.fbz` (a zipped FB2). */
export const UPLOAD_EXTENSIONS: readonly string[] = [...FORMATS, 'fbz']

/** A file's format by its extension (`.fbz` is an FB2); anything else is sent as `epub`, as before. */
export function formatOfName(name: string): ClientFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  if (ext === 'fbz') return 'fb2'
  return (FORMATS.includes(ext) ? ext : 'epub') as ClientFormat
}

/** One part: bytes `[start, end)` of the file, to `index` of `partCount`. */
export interface UploadPart {
  bookId: string
  fileId: string
  index: number
  partCount: number
  start: number
  end: number
}

/**
 * A book's details and cover as read from its file (the reader page's `described`, as `readDescribed` in
 * packages/reader/src/describe.mjs takes it): each field '' when the file has none, the cover a
 * `data:image/jpeg;base64,` URL or null.
 */
export interface FileDetails {
  meta: { title: string; author: string; lang: string; description: string } | null
  cover: string | null
  /** ADR-033 P3: the file's contents (`tocEntries`); sent at import through `tocForServer`. */
  toc?: unknown
}

export interface FileUploadIo {
  /** A v4 uuid. */
  newId(): string
  /** Lowercase hex SHA-256 of the file; asked again on `content_mismatch`. */
  hash(): Promise<string>
  sendPart(part: UploadPart): Promise<unknown>
  /** The last cancel point before the complete (mobile): it throws `aborted` once cancelled. */
  beforeComplete?(): Promise<void>
  /**
   * The book these bytes already are on the server (a synced local book, R6 file sync): only its
   * current file takes them, never an import under new ids (`UploadNotOnServer` instead).
   */
  known?: { bookId: string; fileId: string }
  /**
   * The book's details from its file (#1426), started beside the hash and awaited just before the import; null (or
   * a failure) imports the cleaned file name. Bounded by the caller: an upload waits for it.
   */
  describe?(): Promise<FileDetails | null>
}

export interface UploadResult {
  bookId: string
  format: ClientFormat
  /** The book that already had these bytes (by sha256, or the import's `duplicate_file`); null when imported. */
  found: Book | null
  /** Whether this upload sent the bytes: a new book, or a found one whose bytes never arrived. */
  sent: boolean
}

/**
 * The same bytes already in the library open that book (`found`), its bytes sent first if it has
 * none (an earlier upload broke after the import). `content_mismatch` re-hashes (same hash: send
 * again once; changed: tell the reader); `incomplete_upload` re-sends every part once;
 * `quota_exceeded` carries `used/limit`. An error marked `aborted` (a cancel) removes the book this
 * upload imported: on V2 a book without bytes has no retry.
 * With `io.describe`, a new import carries the file's title (else the cleaned file name), author, language and
 * description, and its cover is sent after the bytes, best-effort.
 */
export async function uploadFile(file: { name: string; size: number; format?: ClientFormat }, maxPartBytes: number, io: FileUploadIo): Promise<UploadResult> {
  const format = file.format ?? formatOfName(file.name)
  let imported: string | null = null
  const described = Promise.resolve().then(() => io.describe?.() ?? null).catch(() => null)
  try {
    const sha256 = await io.hash()
    let found = await syncApi.findBySha256(sha256)
    if (io.known && (found?.id !== io.known.bookId || found.currentFile?.id !== io.known.fileId)) throw new UploadNotOnServer(io.known.bookId)
    let bookId = ''
    let fileId = ''
    if (!found) {
      bookId = io.newId()
      fileId = io.newId()
      const details = await described
      const meta = details?.meta
      const toc = tocForServer(details?.toc)
      const title = clip(bookTitle(meta?.title, file.name), 500)
      try {
        await syncApi.importBook(bookId, {
          title,
          // '' (the file has none) is left out: undefined is not sent.
          author: meta?.author || undefined,
          language: meta?.lang || undefined,
          description: meta?.description || undefined,
          // ADR-033 P3: none read is left out (the reader sends it on a later open).
          file: { id: fileId, sha256, byteSize: file.size, originalName: clip(file.name, 500), format, toc: toc.length ? toc : undefined },
        })
        imported = bookId
      } catch (e) {
        const err = syncApi.syncErrorOf(e)
        if (err?.code !== 'duplicate_file') throw e
        // The book that has these bytes: the 409's `current`, or looked up again when it carries none.
        found = (err.current as Book | undefined) ?? await syncApi.findBySha256(sha256)
        if (!found) throw e
      }
    }
    if (found) {
      if (!found.currentFile || found.currentFile.hasContent) return { bookId: found.id, format, found, sent: false }
      bookId = found.id
      fileId = found.currentFile.id
    }
    await sendBytes(file.size, sha256, bookId, fileId, maxPartBytes, io)
    const cover = imported && (await described)?.cover
    if (cover) await syncApi.putCover(bookId, jpegBytes(cover), 'image/jpeg').catch(() => {})
    return { bookId, format, found, sent: true }
  } catch (e) {
    if ((e as { aborted?: boolean } | null)?.aborted && imported) await syncApi.removeBook(imported).catch(() => {})
    throw e
  }
}

/** A `data:image/jpeg;base64,` URL's bytes. */
export const jpegBytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0))

/** The parts, then the complete, with the retries `uploadFile` names. */
async function sendBytes(size: number, sha256: string, bookId: string, fileId: string, maxPartBytes: number, io: FileUploadIo): Promise<void> {
  const partBytes = Math.max(1, maxPartBytes)
  const partCount = Math.max(1, Math.ceil(size / partBytes))
  const sendAll = async () => {
    for (let index = 0; index < partCount; index++) {
      const start = index * partBytes
      await io.sendPart({ bookId, fileId, index, partCount, start, end: Math.min(start + partBytes, size) })
    }
  }
  const quota = (e: unknown) => {
    const err = syncApi.syncErrorOf(e)
    return err?.code === 'quota_exceeded' ? new FileUploadError('quota_exceeded', err.current as { used: number; limit: number }) : e
  }
  // One second round: every part again after `incomplete_upload` (a part went missing), or after
  // `content_mismatch` when the file still hashes the same (the bytes broke in flight). A file that
  // changed while it was read is the reader's to pick again.
  for (let retried = false; ; retried = true) {
    try {
      await sendAll()
      await io.beforeComplete?.()
    } catch (e) {
      throw quota(e)
    }
    try {
      await syncApi.completeContent(bookId, fileId, partCount)
      return
    } catch (e) {
      const err = syncApi.syncErrorOf(e)
      if (err?.code === 'quota_exceeded') throw quota(e)
      const again = !retried && (err?.code === 'incomplete_upload'
        || (err?.code === 'content_mismatch' && (await io.hash()) === sha256))
      if (again) continue
      throw err?.code === 'content_mismatch' ? new FileUploadError('content_mismatch') : e
    }
  }
}
