/**
 * An upload on V2 for both clients (#1121, PDD "File sync upload protocol"): hash, look the bytes up,
 * import the metadata, send the parts, complete. Each app gives its IO: the hash, the ids, one
 * part's send (XHR + `Blob.slice` on web, `readBytes` + fetch on mobile) and the progress it shows.
 */
import * as v2Api from './v2'
import type { V2Book, V2FileWrite } from './v2'
import { clip } from '../reader/textAnchor'

/** Bytes as whole megabytes, for a quota message. */
export const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

/** A V2 upload the reader must hear about; `code` picks the message. */
export class V2UploadError extends Error {
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
export class V2UploadNotOnServer extends Error {
  constructor(readonly bookId: string) {
    super('The book is not on the server as this device knows it')
  }
}

export type V2ClientFormat = V2FileWrite['format']
const FORMATS: readonly string[] = ['epub', 'pdf', 'mobi', 'azw3', 'fb2', 'cbz']

/** A file's format by its extension (`.fbz` is an FB2); anything else is sent as `epub`, as before. */
export function formatOfName(name: string): V2ClientFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  if (ext === 'fbz') return 'fb2'
  return (FORMATS.includes(ext) ? ext : 'epub') as V2ClientFormat
}

/** One part: bytes `[start, end)` of the file, to `index` of `partCount`. */
export interface V2UploadPart {
  bookId: string
  fileId: string
  index: number
  partCount: number
  start: number
  end: number
}

export interface V2UploadIo {
  /** A v4 uuid. */
  newId(): string
  /** Lowercase hex SHA-256 of the file; asked again on `content_mismatch`. */
  hash(): Promise<string>
  sendPart(part: V2UploadPart): Promise<unknown>
  /** The last cancel point before the complete (mobile): it throws `aborted` once cancelled. */
  beforeComplete?(): Promise<void>
  /**
   * The book these bytes already are on the server (a synced local book, R6 file sync): only its
   * current file takes them, never an import under new ids (`V2UploadNotOnServer` instead).
   */
  known?: { bookId: string; fileId: string }
}

export interface V2UploadResult {
  bookId: string
  format: V2ClientFormat
  /** The book that already had these bytes (by sha256, or the import's `duplicate_file`); null when imported. */
  found: V2Book | null
  /** Whether this upload sent the bytes: a new book, or a found one whose bytes never arrived. */
  sent: boolean
}

/**
 * The same bytes already in the library open that book (`found`), its bytes sent first if it has
 * none (an earlier upload broke after the import). `content_mismatch` re-hashes (same hash: send
 * again once; changed: tell the reader); `incomplete_upload` re-sends every part once;
 * `quota_exceeded` carries `used/limit`. An error marked `aborted` (a cancel) removes the book this
 * upload imported: on V2 a book without bytes has no retry.
 * ponytail: no cover (`PUT /cover` needs an EPUB parse on the client), the title is the file name.
 */
export async function uploadV2File(file: { name: string; size: number; format?: V2ClientFormat }, maxPartBytes: number, io: V2UploadIo): Promise<V2UploadResult> {
  const format = file.format ?? formatOfName(file.name)
  let imported: string | null = null
  try {
    const sha256 = await io.hash()
    let found = await v2Api.findBySha256(sha256)
    if (io.known && (found?.id !== io.known.bookId || found.currentFile?.id !== io.known.fileId)) throw new V2UploadNotOnServer(io.known.bookId)
    let bookId = ''
    let fileId = ''
    if (!found) {
      bookId = io.newId()
      fileId = io.newId()
      const title = clip(file.name.replace(/\.[a-z0-9]+$/i, '').trim() || file.name, 500)
      try {
        await v2Api.importBook(bookId, { title, file: { id: fileId, sha256, byteSize: file.size, originalName: clip(file.name, 500), format } })
        imported = bookId
      } catch (e) {
        const err = v2Api.v2ErrorOf(e)
        if (err?.code !== 'duplicate_file') throw e
        // The book that has these bytes: the 409's `current`, or looked up again when it carries none.
        found = (err.current as V2Book | undefined) ?? await v2Api.findBySha256(sha256)
        if (!found) throw e
      }
    }
    if (found) {
      if (!found.currentFile || found.currentFile.hasContent) return { bookId: found.id, format, found, sent: false }
      bookId = found.id
      fileId = found.currentFile.id
    }
    await sendBytes(file.size, sha256, bookId, fileId, maxPartBytes, io)
    return { bookId, format, found, sent: true }
  } catch (e) {
    if ((e as { aborted?: boolean } | null)?.aborted && imported) await v2Api.removeBook(imported).catch(() => {})
    throw e
  }
}

/** The parts, then the complete, with the retries `uploadV2File` names. */
async function sendBytes(size: number, sha256: string, bookId: string, fileId: string, maxPartBytes: number, io: V2UploadIo): Promise<void> {
  const partBytes = Math.max(1, maxPartBytes)
  const partCount = Math.max(1, Math.ceil(size / partBytes))
  const sendAll = async () => {
    for (let index = 0; index < partCount; index++) {
      const start = index * partBytes
      await io.sendPart({ bookId, fileId, index, partCount, start, end: Math.min(start + partBytes, size) })
    }
  }
  const quota = (e: unknown) => {
    const err = v2Api.v2ErrorOf(e)
    return err?.code === 'quota_exceeded' ? new V2UploadError('quota_exceeded', err.current as { used: number; limit: number }) : e
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
      await v2Api.completeContent(bookId, fileId, partCount)
      return
    } catch (e) {
      const err = v2Api.v2ErrorOf(e)
      if (err?.code === 'quota_exceeded') throw quota(e)
      const again = !retried && (err?.code === 'incomplete_upload'
        || (err?.code === 'content_mismatch' && (await io.hash()) === sha256))
      if (again) continue
      throw err?.code === 'content_mismatch' ? new V2UploadError('content_mismatch') : e
    }
  }
}
