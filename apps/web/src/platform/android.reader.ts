import { syncApi } from '@textstack/shared'
import type { ReaderPlatform } from './reader'
import type { SyncTarget } from '../lib/readerSync'
import { sessionEpoch } from './android/account'
import { retainBook, retainedFile } from './android/deviceDownload'
import { deviceLocalLibrary } from './android/deviceLibrary'
import { syncNow } from './android/library'
import { deviceFileBlob, uuid } from './android/native'
import { createDeviceReaderSync, syncAfterSave } from './android/readerSync'

const aborted = () => new DOMException('aborted', 'AbortError')
/** The bytes of each book opened in this process: a session is kept by them, as in Expo (a pass may re-key the id, #1303). */
const opened = new Map<string, string>()

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
    opened.set(row.id, row.sha256)
    // The local file id; the server's only when the server's file is these bytes. None: nothing is saved.
    const fileId = row.file_id ?? (row.server_sha256 === row.sha256 ? row.server_file_id : null)
    if (!fileId) return { bytes, name: row.original_name }
    const sync: SyncTarget = { bookId: row.id, fileId, format: row.format ?? row.server_format ?? '', sha256: row.sha256, size: row.size ?? row.server_size ?? bytes.byteLength, name: row.original_name }
    askHasToc(sync, row.file_id !== null && row.file_id === row.server_file_id)
    return { bytes, name: row.original_name, sync }
  },
  createSync: createDeviceReaderSync,
  // The Expo reader's path: into the device library under the book's bytes, then a pass sends it. No network here.
  queueSession(session) {
    const lib = deviceLocalLibrary()
    void (async () => {
      const id = session.userBookId
      const sha256 = id ? opened.get(id) ?? (await lib.book(id))?.sha256 : null
      if (!sha256 || !(await lib.addSession(sha256, session, uuid.v4))) console.warn(`[v2] reading session not kept: no book ${session.userBookId}`)
      else syncAfterSave()
    })().catch((e: unknown) => console.warn('[v2] reading session not kept:', e))
  },
  // The reader's mount: the Expo reader's first pass, which retries every entry that stopped being retried.
  flushSessions: async () => { await syncNow(true).catch((e: unknown) => console.warn('[v2] sync failed:', e)) },
  accountEpoch: sessionEpoch,
}

/**
 * ADR-033 P3 (Expo `openedToc.ts`): the device keeps no `hasToc`, so the server is asked once, only for a book whose
 * server file is these bytes. Not waited for: the answer sets `target.hasToc` when it lands, and ReaderHost reads it
 * at the page's `opened`. ponytail: an answer after `opened` (a slow link) sends no TOC this open; a later open asks again.
 */
function askHasToc(target: SyncTarget, serverFile: boolean) {
  if (!serverFile || !navigator.onLine) return
  syncApi.findBySha256(target.sha256).then((b) => {
    if (b?.currentFile?.id === target.fileId) target.hasToc = b.currentFile.hasToc
  }, () => {})
}
