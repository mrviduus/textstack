import { appendPendingSession, drainPendingSessions, syncApi, type PendingSession } from '@textstack/shared'
import type { ReaderPlatform } from './reader'
import type { SyncTarget } from '../lib/readerSync'
import { readItem, writeItem } from '../lib/safeLocalStorage'
import { sessionEpoch } from './android/account'
import { getAccessToken } from './android/api'
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
  // Kept at once (pagehide waits for nothing), then moved into the device library (Expo `addSession`); a pass sends it.
  queueSession(session) {
    const id = session.userBookId
    writeItem(SESSIONS_KEY, JSON.stringify(appendPendingSession(queuedSessions(), { ...session, sha256: id ? opened.get(id) : undefined } as QueuedSession)))
    void moveSessions().then(syncAfterSave)
  },
  // The reader's mount: the Expo reader's first pass, which retries every entry that stopped being retried.
  flushSessions: async () => {
    await moveSessions()
    await syncNow(true).catch((e: unknown) => console.warn('[v2] sync failed:', e))
  },
  accountEpoch: sessionEpoch,
}

/**
 * ADR-033 P3 (Expo `openedToc.ts`): the device keeps no `hasToc`, so the server is asked once, only for a book whose
 * server file is these bytes. Not waited for: the answer sets `target.hasToc` when it lands, and ReaderHost reads it
 * at the page's `opened`. ponytail: an answer after `opened` (a slow link) sends no TOC this open; a later open asks again.
 */
function askHasToc(target: SyncTarget, serverFile: boolean) {
  if (!serverFile || !navigator.onLine) return
  getAccessToken().then(async (token) => {
    if (!token) return
    const b = await syncApi.findBySha256(target.sha256)
    if (b?.currentFile?.id === target.fileId) target.hasToc = b.currentFile.hasToc
  }).catch(() => {})
}

/**
 * Ended reading sessions not in the device library yet: the web queue's shape (`@textstack/shared` pendingSessions),
 * with the book's bytes when the open knew them. Synchronous, so the pagehide's last session is kept.
 */
const SESSIONS_KEY = 'v2reader:pendingSessions'
type QueuedSession = PendingSession & { sha256?: string }
function queuedSessions(): QueuedSession[] {
  try {
    const v = JSON.parse(readItem(SESSIONS_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? (v as QueuedSession[]) : []
  } catch {
    return []
  }
}
const sessionKey = (s: QueuedSession) => s.clientSessionId ?? `${s.userBookId}/${s.startedAt}`
/** Never thrown again (drainPendingSessions drops it): no book with those bytes here (a wipe, a deleted book). */
const noBook = () => Object.assign(new Error('no book with these bytes on the device'), { status: 404 })

let moving: Promise<void> | null = null
let moveAgain = false
/**
 * The queued sessions into the device library, by their client session id (a move cut before its removal from the
 * queue is not kept twice). Removed from the queue only once kept; a failed write stays queued for the next move.
 */
function moveSessions(): Promise<void> {
  if (moving) {
    moveAgain = true
    return moving
  }
  return (moving = (async () => {
    const lib = deviceLocalLibrary()
    try {
      do {
        moveAgain = false
        const snapshot = queuedSessions()
        if (!snapshot.length) return
        const kept = await drainPendingSessions(snapshot, async (s) => {
          const q = s as QueuedSession
          const id = q.clientSessionId ?? uuid.v4()
          if (await lib.session(id)) return
          const sha256 = q.sha256 ?? (q.userBookId ? (await lib.book(q.userBookId))?.sha256 : null)
          if (!sha256 || !(await lib.addSession(sha256, q, () => id))) throw noBook()
        })
        // From a fresh read: a session queued during the move stays.
        const left = new Set(kept.map(sessionKey))
        const settled = new Set(snapshot.map(sessionKey).filter((k) => !left.has(k)))
        writeItem(SESSIONS_KEY, JSON.stringify(queuedSessions().filter((s) => !settled.has(sessionKey(s)))))
      } while (moveAgain)
    } catch (e) {
      console.warn('[v2] reading sessions not kept on the device:', e)
    } finally {
      moving = null
    }
  })())
}
