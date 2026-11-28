import type { ReaderPlatform } from './reader'
import { notYet } from './android'
import { retainBook, retainedFile } from './android/deviceDownload'
import { deviceLocalLibrary } from './android/deviceLibrary'
import { syncNow } from './android/library'
import { deviceFileBlob } from './android/native'

const aborted = () => new DOMException('aborted', 'AbortError')

/** The Android reader (ADR-035): the retained file on the device and the local store. Wave 5 (#1642). */
export const reader: ReaderPlatform = {
  // The reader needs no network and no server answer on Android.
  ready: async () => {},
  readyNow: () => true,
  /**
   * The retained file (`v2/books/<sha256>.epub`), read through the WebView: no network, no account. A book not on
   * the device is downloaded first (a sync pass first when the device does not know its server file yet), as the
   * Expo reader does; offline that fails, and the error is the reader's. Null: the book has no readable file.
   */
  async openBook(id, o) {
    o.onActivity()
    let file = await retainedFile(id)
    if (!file) {
      if (!(await retainBook(id, syncNow))) return null
      if (o.signal.aborted) throw aborted()
      file = await retainedFile(id)
      if (!file) return null
    }
    o.onActivity()
    const row = await deviceLocalLibrary().book(id)
    if (!row?.sha256 || o.signal.aborted) throw o.signal.aborted ? aborted() : new Error('the book is not in the device library')
    const bytes = await (await deviceFileBlob(file.uri)).arrayBuffer()
    o.onActivity()
    const name = row.original_name
    const fileId = row.file_id ?? row.server_file_id
    // The reader's data of this file goes to the device library (createSync); the pass sends it on.
    const sync = fileId ? { bookId: id, fileId, format: row.format ?? row.server_format ?? file.format ?? 'epub', sha256: row.sha256, size: row.size ?? bytes.byteLength, name } : undefined
    return { bytes, name, sync }
  },
  createSync: notYet('reader.createSync'),
  queueSession: notYet('reader.queueSession'),
  flushSessions: notYet('reader.flushSessions'),
  accountEpoch: notYet('reader.accountEpoch'),
}
