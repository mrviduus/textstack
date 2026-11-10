/**
 * The V2 local library's sync client (R6, #1038; PDD v2-sync-protocol.md "Pull and push", "The
 * revision rule", "Conflict codes", "File sync upload protocol"). One pass: pull the three feeds
 * from their cursors, drain the outbox in order (books → states → annotations), then — only with
 * file sync on — send the bytes the server lacks. Opportunistic: the reading path never waits for
 * it; a failure (offline, 5xx, 503 `v2_unavailable`) ends the pass and loses nothing local, the
 * outbox is retried whole by the next one (every write is idempotent by client id or revision).
 * Every answer lands only while the session that asked is current: the shared `whileCurrent`
 * epoch guard (#1151, #1155), and a write after a caught 409 checks the same epoch first.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  v2Api, clip, highlightWrite, isOfflineError, ownAnnotationWrite, ownStateWrite, positionWrite,
  type OpenReader, type PageHighlight, type V2Annotation, type V2Book, type V2BookFile, type V2FileWrite, type V2MergeMap, type V2ReadingState,
} from '@textstack/shared'
import { onV2, resetSince, startV2Probe, whileCurrent, V2UploadError } from '../v2'
import { createSingleFlight } from '../singleFlight'
import { deviceLocalLibrary, FEEDS, type BookRow, type LocalLibrary, type OutboxItem, type PositionAction } from './localLibrary'

/** The account the local library last synced with (AsyncStorage: readable without opening the database). */
export const ACCOUNT_KEY = 'v2local.account'

export interface SyncHost {
  /** The session's user id (a guest's too: ADR-014). */
  userId: string
  newId(): string
  /** The open reader of a book, for ADR-019's adopt/move/prompt; null when that book is not open. */
  reader(bookId: string): OpenReader | null
  /** What a pulled or lost-to position owes the open reader (go there, or ask). */
  onPosition?(a: PositionAction): void
  /** Sends a local book's bytes (file sync on); `cancelled` turns true once the session changed. */
  upload?(book: BookRow, maxPartBytes: number, cancelled: () => boolean): Promise<void>
}

type V2FileFormat = V2FileWrite['format']

export type SyncResult = 'off' | 'done' | 'dropped' | 'failed'

/** Thrown to end a pass whose session changed: nothing more of it may land. */
const DROPPED = Symbol('dropped')
type Reset = () => boolean

/** `work`'s answer (null included), `keep` run in the checked tick; the pass ends if the session changed. */
async function current<T>(reset: Reset, work: Promise<T>, keep?: (v: T) => unknown): Promise<T> {
  const v = await whileCurrent(work, keep, reset)
  if (v === null && reset()) throw DROPPED
  return v as T
}

/** A local write after a caught answer: queued in this tick, and only while the session is the one that asked. */
function checked<T>(reset: Reset, write: () => Promise<T>): Promise<T> {
  if (reset()) throw DROPPED
  return write()
}

const flight = createSingleFlight<SyncResult>()

/** One sync pass; concurrent callers share the one in flight. */
export const syncV2Library = (lib: LocalLibrary, host: SyncHost): Promise<SyncResult> => flight.run(() => pass(lib, host))

async function pass(lib: LocalLibrary, host: SyncHost): Promise<SyncResult> {
  const reset = resetSince()
  try {
    if (!(await onV2())) return 'off'
    await account(lib, host.userId, reset)
    await pull(lib, host, reset)
    // Kind by kind, the outbox read again each time: a book push can re-key the ids its children name.
    for (const [kind, push] of [['book', pushBook], ['state', pushState], ['annotation', pushAnnotation]] as const) {
      for (const item of await lib.outbox()) if (item.kind === kind) await push(lib, host, reset, item)
    }
    await fileSync(lib, host, reset)
    return 'done'
  } catch (e) {
    if (e === DROPPED || reset()) return 'dropped'
    console.warn('[v2 sync] pass ended:', e)
    return 'failed'
  }
}

/**
 * Another identity than the one this library last synced with: what the server told that one is
 * forgotten (`forgetServerState`; a guest → account sign-in moved it first, `adoptV2LocalAccount`).
 */
async function account(lib: LocalLibrary, userId: string, reset: Reset) {
  const last = await AsyncStorage.getItem(ACCOUNT_KEY)
  if (last === userId) return
  if (last) await checked(reset, () => lib.forgetServerState())
  await checked(reset, () => AsyncStorage.setItem(ACCOUNT_KEY, userId))
}

/**
 * PDD "Guest → account merge", the local library's part (AuthContext, after `applyV2MergeMap`): a
 * guest's library becomes the account's — ids re-keyed by the merge map, every cursor cleared (the
 * next pull is full), the outbox kept. Nothing to do when the library never synced as that guest.
 */
export async function adoptV2LocalAccount(guestId: string, accountId: string, merge?: V2MergeMap, lib: () => LocalLibrary = deviceLocalLibrary) {
  if ((await AsyncStorage.getItem(ACCOUNT_KEY)) !== guestId) return
  if (merge) await lib().rekey(merge.books ?? {}, merge.files ?? {})
  await lib().clearCursors()
  await AsyncStorage.setItem(ACCOUNT_KEY, accountId)
}

async function pull(lib: LocalLibrary, host: SyncHost, reset: Reset) {
  for (const feed of FEEDS) {
    const cursor = await lib.cursor(feed)
    let owed: PositionAction[] = []
    await current(reset, v2Api.pullAll<unknown>(feed, cursor), async ({ items, cursor: next }) => {
      // Both queued in this tick: the rows and their cursor land together, before any later wipe.
      const applied = feed === 'library' ? lib.applyBooks(items as V2Book[])
        : feed === 'reading' ? lib.applyStates(items as V2ReadingState[], host.reader)
          : lib.applyAnnotations(items as V2Annotation[])
      const saved = lib.setCursor(feed, next)
      owed = (await applied) ?? []
      await saved
    })
    owe(host, reset, owed)
  }
}

const owe = (host: SyncHost, reset: Reset, owed: PositionAction[] | void) => {
  if (!reset()) for (const o of owed ?? []) host.onPosition?.(o)
}

/** PDD "File sync upload protocol" steps 1–2, metadata only: sha256 first, then the import. */
async function pushBook(lib: LocalLibrary, host: SyncHost, reset: Reset, item: OutboxItem, retried = false): Promise<void> {
  const b = await lib.book(item.target)
  if (!b || b.imported_at == null || !b.sha256 || !b.file_id || b.size == null) return void (await checked(reset, () => lib.done(item)))
  // The format comes from the page's `opened`: a book imported from R2's JSON waits for its next open.
  if (!b.format) return
  const found = await current(reset, v2Api.findBySha256(b.sha256))
  if (found) return void (await checked(reset, () => lib.adoptServerBook(b.id, found)))
  try {
    await current(reset, v2Api.importBook(b.id, {
      title: clip(b.title, 500),
      author: b.author || null,
      file: { id: b.file_id, sha256: b.sha256, byteSize: b.size, originalName: clip(b.original_name, 500), format: b.format as V2FileFormat },
    }), (server) => lib.adoptServerBook(b.id, server))
  } catch (e) {
    const err = v2Api.v2ErrorOf(e)
    switch (err?.code) {
      case 'duplicate_file':
        // Another book of the user's has these bytes: it is this book (PDD: re-key as for a merge map).
        if (err.current) return void (await checked(reset, () => lib.adoptServerBook(b.id, err.current as V2Book)))
        throw e
      case 'id_conflict': {
        if (retried) throw e
        const id = await checked(reset, () => lib.rekeyBook(b.id, host.newId))
        return pushBook(lib, host, reset, { ...item, target: id }, true)
      }
      case 'invalid_payload':
        console.warn('[v2 sync] book refused:', err.field, err.message)
        return void (await checked(reset, () => lib.done(item)))
      default:
        throw e
    }
  }
}

/** The book is not (or no longer) on the server as this device knows it: push it first, keep the child queued. */
const bookFirst = (lib: LocalLibrary, reset: Reset, bookId: string) => checked(reset, () => lib.enqueue('book', bookId))

/**
 * PDD "Reading state" + "The revision rule": the position on this device's file, `expectedRevision`
 * the one last seen on that file. Lost: an own write is success; `stale_revision` runs ADR-019
 * (`applyStates`: adopt/move take theirs; keep/prompt write ours once more on their revision);
 * `reset` writes again on the new revision (no local frontier to drop); `file_replaced` drops the
 * write (the old copy keeps reading offline); `unknown_file` / `book_not_found` push the book first.
 */
async function pushState(lib: LocalLibrary, host: SyncHost, reset: Reset, item: OutboxItem, retried = false): Promise<void> {
  const b = await lib.book(item.target)
  const st = await lib.state(item.target)
  if (!b?.file_id || !st?.position) return void (await checked(reset, () => lib.done(item)))
  if (!b.server_file_id) return void (await bookFirst(lib, reset, b.id))
  // Replaced on another device: no write on this file can land (rule 6).
  if (b.server_file_id !== b.file_id) return void (await checked(reset, () => lib.done(item)))
  const write = positionWrite(JSON.parse(st.position), b.file_id, st.revision_file_id === b.file_id ? st.revision : null)
  // A CBZ page has no quote: no position the server takes yet (PDD "CBZ positions: open question").
  if (!write) return void (await checked(reset, () => lib.done(item)))
  const landed = (s: V2ReadingState) => Promise.all([lib.setStateRevision(b.id, s.revision, s.fileId), lib.done(item)])
  try {
    await current(reset, v2Api.putReadingState(b.id, write), landed)
  } catch (e) {
    const err = v2Api.v2ErrorOf(e)
    const cur = (err?.current ?? null) as V2ReadingState | null
    const again = () => (retried ? undefined : pushState(lib, host, reset, item, true))
    switch (err?.code) {
      case 'stale_revision': {
        if (cur && ownStateWrite(cur, write)) return void (await checked(reset, () => landed(cur)))
        if (!cur) {
          await checked(reset, () => lib.setStateRevision(b.id, null, null))
          return again()
        }
        const owed = await checked(reset, () => lib.applyStates([cur], host.reader))
        owe(host, reset, owed)
        return !owed.length || owed[0].action === 'prompt' ? again() : undefined
      }
      case 'reset':
        await checked(reset, () => lib.setStateRevision(b.id, cur?.revision ?? null, cur?.fileId ?? null))
        return again()
      case 'file_replaced':
        return void (await checked(reset, () => Promise.all([lib.setServerFile(b.id, (err.currentFile ?? null) as V2BookFile | null), lib.done(item)])))
      case 'unknown_file':
      case 'book_not_found':
        await checked(reset, () => lib.setServerFile(b.id, null))
        return void (await bookFirst(lib, reset, b.id))
      case 'chapter_not_found':
      case 'invalid_payload':
        console.warn('[v2 sync] reading state refused:', err.code, err.field ?? '')
        return void (await checked(reset, () => lib.done(item)))
      default:
        throw e
    }
  }
}

/**
 * PDD "Annotations": created with `expectedRevision` null, edited on the revision last seen. Lost:
 * an own write is success; `stale_revision` re-applies this device's fields once on the server's
 * revision, then keeps the server's; `deleted` deletes here (a tombstone wins); `id_conflict` mints
 * a new id; `unknown_file` / `book_not_found` push the book first.
 */
async function pushAnnotation(lib: LocalLibrary, host: SyncHost, reset: Reset, item: OutboxItem, retried = false): Promise<void> {
  const a = await lib.annotation(item.target)
  const b = a && (await lib.book(a.book_id))
  if (!a || !b || a.deleted_at) return void (await checked(reset, () => lib.done(item)))
  if (!b.server_file_id) return void (await bookFirst(lib, reset, b.id))
  const write = highlightWrite(JSON.parse(a.highlight) as PageHighlight, a.book_id, (a.file_id ?? b.file_id)!, a.revision)
  if (!write) return void (await checked(reset, () => lib.done(item)))
  const landed = (revision: number) => Promise.all([lib.setAnnotationRevision(a.id, revision), lib.done(item)])
  try {
    await current(reset, v2Api.putAnnotation(a.id, write), (s) => landed(s.revision))
  } catch (e) {
    const err = v2Api.v2ErrorOf(e)
    const cur = (err?.current ?? null) as V2Annotation | null
    switch (err?.code) {
      case 'stale_revision':
        if (cur && ownAnnotationWrite(cur, write)) return void (await checked(reset, () => landed(cur.revision)))
        if (cur && !retried) {
          await checked(reset, () => lib.setAnnotationRevision(a.id, cur.revision))
          return pushAnnotation(lib, host, reset, item, true)
        }
        return void (await checked(reset, () => Promise.all([cur ? lib.setAnnotation(cur) : null, lib.done(item)])))
      case 'deleted':
        return void (await checked(reset, () => Promise.all([cur ? lib.setAnnotation(cur) : null, lib.done(item)])))
      case 'id_conflict': {
        if (retried) throw e
        const id = await checked(reset, () => lib.rekeyAnnotation(a.id, host.newId))
        return pushAnnotation(lib, host, reset, { ...item, target: id }, true)
      }
      case 'unknown_file':
      case 'book_not_found':
        await checked(reset, () => lib.setServerFile(b.id, null))
        return void (await bookFirst(lib, reset, b.id))
      case 'chapter_not_found':
      case 'invalid_payload':
        console.warn('[v2 sync] annotation refused:', err.code, err.field ?? '')
        return void (await checked(reset, () => lib.done(item)))
      default:
        throw e
    }
  }
}

/**
 * Story B5, opt-in (off by default): each pushed book whose bytes the server lacks — and that no
 * device stopped syncing (`contentRemovedAt`) — goes up through the shared `uploadV2File`. A full
 * quota stops the round (the books stay local); offline ends the pass.
 */
async function fileSync(lib: LocalLibrary, host: SyncHost, reset: Reset) {
  if (!host.upload || !(await lib.fileSync())) return
  const { maxPartBytes } = await startV2Probe()
  for (const b of await lib.uploadable()) {
    if (reset()) throw DROPPED
    try {
      await host.upload(b, maxPartBytes, reset)
      await checked(reset, () => lib.setHasContent(b.id))
    } catch (e) {
      if (e === DROPPED || reset() || isOfflineError(e)) throw e
      console.warn('[v2 sync] upload failed:', b.id, e)
      if (e instanceof V2UploadError && e.code === 'quota_exceeded') return
    }
  }
}

/**
 * Download on demand: a book the server holds bytes for, not imported here. `fetch` lands the bytes
 * (checked against the sha256) in staging; `retain` makes them the retained copy, then the row says
 * so. A session change while it downloads keeps nothing (staging is cleared on the next start).
 */
export async function downloadV2Book(lib: LocalLibrary, bookId: string, io: {
  fetch(url: string, sha256: string): Promise<string>
  retain(staged: string, sha256: string): Promise<void>
}): Promise<boolean> {
  const reset = resetSince()
  const b = await lib.book(bookId)
  if (!b?.server_file_id || !b.server_sha256 || !b.has_content || b.imported_at != null) return false
  const sha = b.server_sha256
  try {
    const staged = await current(reset, io.fetch(v2Api.contentUrl(b.id, b.server_file_id), sha))
    await checked(reset, () => io.retain(staged, sha))
    await checked(reset, () => lib.markDownloaded(b.id))
    return true
  } catch (e) {
    if (e === DROPPED) return false
    throw e
  }
}
