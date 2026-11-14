/**
 * The V2 local library's sync client (R6, #1038; PDD v2-sync-protocol.md "Pull and push", "The
 * revision rule", "Conflict codes", "File sync upload protocol"). One pass: pull the three feeds
 * from their cursors, page by page, push the outbox kind by kind (books → states → annotations),
 * then — only with file sync on — send the bytes the server lacks. Opportunistic: the reading path
 * never waits for it. Offline or 503 `v2_unavailable` ends the pass; any other failure of one
 * outbox entry skips that entry only, and counts against it: after `MAX_FAILURES` it is kept but no
 * longer retried until it changes, "Try again", or the next session. Nothing local is lost; every write is idempotent by client id
 * or revision, so the next pass retries what is left. Every answer lands only while the session
 * that asked is current: the shared `whileCurrent` epoch guard (#1151, #1155), and a write after a
 * caught 409 checks the same epoch first.
 */
import { Platform } from 'react-native'
import {
  v2Api, ApiError, clip, highlightWrite, isOfflineError, ownAnnotationWrite, ownStateWrite, positionWrite, V2UploadNotOnServer,
  type OpenReader, type PageHighlight, type V2Annotation, type V2Book, type V2BookFile, type V2ClientFormat, type V2MergeMap, type V2ReadingState,
} from '@textstack/shared'
import { onV2, resetSince, startV2Probe, whileCurrent, V2UploadError } from '../v2'
import { uuid } from 'expo-modules-core'
import { withDeadline } from '../deadline'
import { createSingleFlight } from '../singleFlight'
import { clearV2Files, deviceLocalLibrary } from './deviceLibrary'
import { FEEDS, MAX_FAILURES, identityStep, wipeV2Library, type BookRow, type LocalFeed, type LocalLibrary, type OutboxItem, type PositionAction } from './localLibrary'

export interface SyncHost {
  /** The session's user id (a guest's too: ADR-014). */
  userId: string
  newId(): string
  /** The open reader of a book, for ADR-019's adopt/move/prompt; null when that book is not open. */
  reader(bookId: string): OpenReader | null
  /** What a pulled or lost-to position owes the open reader (go there, or ask). */
  onPosition?(a: PositionAction): void
  /**
   * Sends a local book's bytes (file sync on) to its KNOWN server book and file only — never an
   * import under new ids (`V2UploadNotOnServer` then); `cancelled` turns true once the session changed.
   */
  upload?(book: BookRow, maxPartBytes: number, cancelled: () => boolean): Promise<void>
  /** A session's first pass (screen mounted, another user): every failure count reset first (`retryAll`). */
  retryFailed?: boolean
  /** Whether the session's user is a guest (`capabilitiesFor(user).isGuest`): a guest's library carries over (#1070). */
  guest: boolean
}

/** `refused`: the library belongs to another real account (#1070 rule D); nothing pulled, pushed or recorded. */
export type SyncResult = 'off' | 'done' | 'dropped' | 'failed' | 'refused'

/** Thrown to end a pass whose session changed: nothing more of it may land. */
const DROPPED = Symbol('dropped')
/** Thrown to end a pass for an identity the library does not belong to. */
const REFUSED = Symbol('refused')
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

/** The entry leaves the outbox (pushed, dropped or refused), while the session is the one that asked. */
const drop = async (lib: LocalLibrary, reset: Reset, item: OutboxItem) => void (await checked(reset, () => lib.done(item)))

/**
 * An error that ends the pass (no point pushing the rest), counted against no entry: offline, or the
 * server down — any 503, `v2_unavailable` or not. Known limit: one entry answered 503 (or failing at
 * fetch level) ends the pass for the entries after it too.
 */
const endsPass = (e: unknown) => e === DROPPED || isOfflineError(e) || (e as { status?: number } | null)?.status === 503

export { MAX_FAILURES }

/**
 * An error as a park reason or a log line, without user content: the server's message (clipped) for
 * an answer; only the name for a local error (a corrupt row's SyntaxError can quote book text).
 */
function brief(e: unknown): string {
  if (!(e instanceof ApiError)) return (e as Error | null)?.name ?? 'Error'
  const code = v2Api.v2ErrorOf(e)?.code
  return `${e.status}${code ? ` ${code}` : ''}: ${clip(e.message, 120)}`
}

/**
 * One more failed attempt of `item`, counted against its gen; logged from the row's count (a save
 * or "Try again" meanwhile changed it): once at the limit, the entry is kept and no longer retried.
 */
async function failedOnce(lib: LocalLibrary, reset: Reset, item: OutboxItem, e: unknown) {
  const n = await checked(reset, () => lib.failed(item))
  if (n === null) return // queued again meanwhile: a fresh attempt, nothing counted
  if (n < MAX_FAILURES) console.warn(`[v2 sync] ${item.kind} ${item.target} not pushed (${n}/${MAX_FAILURES}), retried next pass:`, brief(e))
  else console.warn(`[v2 sync] ${item.kind} ${item.target} failed ${n} times (last: ${brief(e)}): kept on the device, not retried until it changes, "Try again" or the next session`)
}

let running: Promise<SyncResult> | null = null
let next: { lib: LocalLibrary; host: SyncHost; reset: Reset } | null = null

/**
 * One sync pass at a time. A trigger while one runs (a save after its outbox snapshot, a new
 * session joining a pass of the old one that ends dropped) is not folded into it: it asks for one
 * more pass, with the latest caller's host, when the running one ends. Callers get the last pass's result.
 * The session is the one current when the pass was asked for: a pass still waiting when the session
 * changes (sign-out, then its wipe) is dropped unrun, never run later under the old user id.
 */
export function syncV2Library(lib: LocalLibrary, host: SyncHost): Promise<SyncResult> {
  // A session's first pass asked while another waits is not lost to a later plain trigger.
  next = { lib, host: { ...host, retryFailed: host.retryFailed || next?.host.retryFailed }, reset: resetSince() }
  return (running ??= (async () => {
    let result: SyncResult = 'done'
    try {
      while (next) {
        const asked = next
        next = null
        result = await pass(asked.lib, asked.host, asked.reset)
      }
      return result
    } finally {
      running = null
    }
  })())
}

const PUSHES = [['book', pushBook], ['state', pushState], ['annotation', pushAnnotation]] as const

async function pass(lib: LocalLibrary, host: SyncHost, reset: Reset, pushOnly = false): Promise<SyncResult> {
  if (reset()) return 'dropped'
  try {
    if (!(await onV2())) return 'off'
    await account(lib, host, reset)
    if (host.retryFailed) await checked(reset, () => lib.retryAll())
    if (!pushOnly) for (const feed of FEEDS) await pull(lib, host, reset, feed)
    let failed = false
    // Kind by kind, the outbox read again each time: a book push can re-key the ids its children name.
    // Each entry on its own: one that keeps failing is counted and, at the limit, no longer read (`due`),
    // never starving the rest. Errors that end the pass say nothing about the entry: not counted.
    for (const [kind, push] of PUSHES) {
      for (const item of await lib.due(kind)) {
        try {
          await push(lib, host, reset, item)
        } catch (e) {
          if (endsPass(e) || reset()) throw e
          failed = true
          await failedOnce(lib, reset, item, e)
        }
      }
    }
    if (!pushOnly) await fileSync(lib, host, reset)
    return failed ? 'failed' : 'done'
  } catch (e) {
    if (e === REFUSED) return 'refused'
    if (e === DROPPED || reset()) return 'dropped'
    console.warn('[v2 sync] pass ended:', brief(e))
    return 'failed'
  }
}

/**
 * Whom the library belongs to (#1070 rule D). Never destructive: a pass's user id is a render closure
 * that can lag the session. The owner → go on (a guest promoted in place is recorded as an account);
 * nobody → this identity takes it; a guest → carried to this identity (`forgetServerState`: the
 * server's knowledge goes, own rows and queue stay; `adoptV2LocalAccount` normally did it first);
 * another real account → the pass is refused, nothing pulled, pushed or recorded (the wipe is
 * sign-in's, `claimV2LibraryFor`).
 */
async function account(lib: LocalLibrary, host: SyncHost, reset: Reset) {
  const owner = await lib.owner()
  switch (identityStep(owner, host.userId)) {
    case 'same':
      if (owner!.guest !== host.guest) await checked(reset, () => lib.setAccount(host.userId, host.guest))
      return
    case 'claim':
      return void (await checked(reset, () => lib.setAccount(host.userId, host.guest)))
    case 'carry':
      return void (await checked(reset, () => lib.forgetServerState(host.userId, host.guest)))
    case 'foreign':
      console.warn('[v2 sync] the local V2 library belongs to another account: pass refused (it is wiped at that sign-in)')
      throw REFUSED
  }
}

/**
 * Sign-in (#1070 rule B; AuthContext, before the session's user is set, where the identity is
 * authoritative; no server needed): a library owned by another real account is wiped, its loss logged
 * with the counts. A guest's library carries over; the same account's is kept; an un-owned one waits
 * for the first pass. Android only.
 */
export async function claimV2LibraryFor(userId: string, lib: () => LocalLibrary = deviceLocalLibrary, clearFiles: () => void = clearV2Files) {
  if (Platform.OS === 'web') return
  const l = lib()
  if (identityStep(await l.owner(), userId) !== 'foreign') return
  const loss = await l.signOutLoss()
  console.warn(`[v2] another account signed in: the previous account's local V2 library is wiped; lost ${loss.books} book(s) and ${loss.writes} change(s) not on the server`)
  await wipeV2Library(l, clearFiles)
}

/**
 * "Try again" on a book not synced: its counts reset (a parked book unparked), the list refreshed at
 * once — with no session there is no pass to refresh it — then a pass.
 */
export async function tryAgainV2Book(lib: LocalLibrary, bookId: string, refresh: () => Promise<unknown>, sync: () => void) {
  await lib.unpark(bookId)
  await refresh()
  sync()
}

/**
 * PDD "Guest → account merge", the local library's part (AuthContext, after `applyV2MergeMap`): a
 * library that synced as this guest becomes the account's — ids re-keyed by the merge map, every
 * cursor cleared, the identity recorded, in one transaction; the outbox kept. Android only (the web
 * bundle has no local library). Safe to replay: the re-key is idempotent.
 */
export async function adoptV2LocalAccount(guestId: string, accountId: string, merge?: V2MergeMap, lib: () => LocalLibrary = deviceLocalLibrary) {
  if (Platform.OS === 'web') return
  await lib().adoptAccount(guestId, merge?.books ?? {}, merge?.files ?? {}, accountId)
}

/** How long sign-out waits for its one pass before checking what would be lost. */
export const SIGN_OUT_SYNC_MS = 4000

/** Sign-out's push, in its own slot: never replaces a reader screen's pass waiting in `next`. */
const signOutPush = createSingleFlight<SyncResult>()

/**
 * Sign-out's one push before the loss check (#1070; the PDD's "offer to sync first", without a button):
 * the outbox only — pulls would fetch data about to be wiped — so a write only waiting for the screen's
 * 10 s timer goes now and is neither reported nor lost. Its own slot (a concurrent reader pass may push
 * the same entry: every write is idempotent by client id or revision). Bounded; offline, V2 off, a
 * failure or the deadline just go on to the check. Android only.
 */
export async function pushV2BeforeSignOut(userId: string, guest: boolean, ms = SIGN_OUT_SYNC_MS, lib: () => LocalLibrary = deviceLocalLibrary) {
  if (Platform.OS === 'web') return
  const reset = resetSince()
  const host: SyncHost = { userId, guest, newId: uuid.v4, reader: () => null }
  await withDeadline(signOutPush.run(() => pass(lib(), host, reset, true)), ms).catch(() => {})
}

/**
 * One feed, page by page from its cursor: each page lands with its own cursor in one transaction
 * (a page that fails to land is pulled again), queued in the tick its answer was checked.
 */
async function pull(lib: LocalLibrary, host: SyncHost, reset: Reset, feed: LocalFeed) {
  let cursor = await lib.cursor(feed)
  for (;;) {
    let owed: PositionAction[] = []
    const page = await current(reset, v2Api.getChanges<unknown>(feed, cursor), async ({ items, cursor: c }) => {
      const at = c ?? cursor
      if (feed === 'library') await lib.applyBooks(items as V2Book[], at)
      else if (feed === 'reading') owed = await lib.applyStates(items as V2ReadingState[], host.reader, at)
      else await lib.applyAnnotations(items as V2Annotation[], at)
    })
    owe(host, reset, owed)
    cursor = page.cursor ?? cursor
    if (!page.hasMore) return
  }
}

const owe = (host: SyncHost, reset: Reset, owed: PositionAction[]) => {
  if (!reset()) for (const o of owed) host.onPosition?.(o)
}

/**
 * A refusal no retry can change: the book is parked (it and its children unsent) until it changes,
 * "Try again" or the server turns out to hold it — unless it was queued again meanwhile. Logged once.
 */
async function park(lib: LocalLibrary, reset: Reset, item: OutboxItem, why: string) {
  if (await checked(reset, () => lib.park(item, why))) console.warn(`[v2 sync] book ${item.target} refused (${why}): parked until it changes`)
}

/** PDD "File sync upload protocol" steps 1–2, metadata only: sha256 first, then the import. */
async function pushBook(lib: LocalLibrary, host: SyncHost, reset: Reset, item: OutboxItem, retried = false): Promise<void> {
  const b = await lib.book(item.target)
  if (!b || b.imported_at == null || !b.sha256 || !b.file_id || b.size == null || b.blocked) return drop(lib, reset, item)
  // The format comes from the page's `opened`: a book imported from R2's JSON waits for its next open.
  if (!b.format) return
  const found = await current(reset, v2Api.findBySha256(b.sha256))
  if (found) return void (await checked(reset, () => lib.adoptServerBook(b.id, found)))
  try {
    await current(reset, v2Api.importBook(b.id, {
      title: clip(b.title, 500),
      author: b.author || null,
      file: { id: b.file_id, sha256: b.sha256, byteSize: b.size, originalName: clip(b.original_name, 500), format: b.format as V2ClientFormat },
    }), (server) => lib.adoptServerBook(b.id, server))
  } catch (e) {
    const err = v2Api.v2ErrorOf(e)
    switch (err?.code) {
      case 'duplicate_file':
        // Another book of the user's has these bytes: it is this book (PDD: re-key as for a merge map).
        if (err.current) return void (await checked(reset, () => lib.adoptServerBook(b.id, err.current as V2Book)))
        return park(lib, reset, item, 'duplicate_file without the book')
      case 'id_conflict': {
        if (retried) return park(lib, reset, item, 'id_conflict twice')
        // The entry itself is re-keyed (rekeyIn): a failure of the retry counts against the new target.
        item.target = await checked(reset, () => lib.rekeyBook(b.id, host.newId))
        return pushBook(lib, host, reset, item, true)
      }
      case 'invalid_payload':
        return park(lib, reset, item, `${brief(e)}${err.field ? ` (${clip(err.field, 40)})` : ''}`)
      default:
        throw e
    }
  }
}

/**
 * The child's book, when the server has it as this device knows it; otherwise null and the book is
 * asked for first (the child stays queued) — unless the book is parked: its children wait for it.
 */
async function pushedBook(lib: LocalLibrary, reset: Reset, b: BookRow): Promise<BookRow | null> {
  if (b.server_file_id) return b
  await bookFirst(lib, reset, b)
  return null
}

const bookFirst = async (lib: LocalLibrary, reset: Reset, b: BookRow) => {
  if (!b.blocked) await checked(reset, () => lib.queueBook(b.id))
}

/**
 * A child write's answer every child kind treats alike: `unknown_file` / `book_not_found` push the
 * book first and answer false, so the caller throws and the attempt counts (the child stays queued;
 * a server that keeps saying so after the book is re-adopted stops being asked after MAX_FAILURES);
 * `chapter_not_found` / `invalid_payload` drop it, logged. False for any other code too.
 */
async function refusedChild(lib: LocalLibrary, reset: Reset, item: OutboxItem, b: BookRow, err: { code: string; field?: string } | null): Promise<boolean> {
  switch (err?.code) {
    case 'unknown_file':
    case 'book_not_found':
      await checked(reset, () => lib.setServerFile(b.id, null))
      await bookFirst(lib, reset, b)
      return false
    case 'chapter_not_found':
    case 'invalid_payload':
      console.warn(`[v2 sync] ${item.kind} refused:`, err.code, err.field ?? '')
      await drop(lib, reset, item)
      return true
    default:
      return false
  }
}

/**
 * PDD "Reading state" + "The revision rule": the position on this device's file, `expectedRevision`
 * the one last seen on that file. Lost: an own write is success; `stale_revision` runs ADR-019
 * (`applyStates`: adopt/move take theirs; keep/prompt write ours once more on their revision);
 * `reset` drops the local completion and writes again on the new revision; `file_replaced` drops the
 * write (the old copy keeps reading offline); `unknown_file` / `book_not_found` push the book first.
 */
async function pushState(lib: LocalLibrary, host: SyncHost, reset: Reset, item: OutboxItem, retried = false): Promise<void> {
  const local = await lib.book(item.target)
  const st = await lib.state(item.target)
  // A finish with no place the server takes (no position yet, a fraction-only one): kept queued, never dropped
  // while it stands, so the first place that can be written carries it and a sign-out counts it (UNSENT_CHANGES).
  const owesFinish = !!st?.completed_at
  if (!local?.file_id || !st?.position) return owesFinish && local?.file_id ? undefined : drop(lib, reset, item)
  const b = await pushedBook(lib, reset, local)
  if (!b) return
  // Replaced on another device: no write on this file can land (rule 6).
  if (b.server_file_id !== b.file_id) return drop(lib, reset, item)
  // The scheme fits the file: pdf-page on a PDF, page-name on a CBZ or a pre-paginated EPUB page (#1188, #1196), epub-cfi on any other (#1128 S5).
  const place = positionWrite(JSON.parse(st.position), b.file_id!, st.revision_file_id === b.file_id ? st.revision : null, Date.now(), b.format)
  // "Finish book" (#1266): sent with every write while it stands; the server keeps the first (`COALESCE`).
  const write = place && st.completed_at ? { ...place, completedAt: st.completed_at } : place
  // No write the server would take (a page key it refuses; a fraction-only position, #1187, is never queued:
  // localLibrary.applyEntry). An unsent finish stays queued for the first place the server takes.
  if (!write) return owesFinish ? undefined : drop(lib, reset, item)
  // The server's `completedAt` with its revision: a finish elsewhere shows here without waiting for a pull.
  const landed = (s: V2ReadingState) => Promise.all([lib.takeState(b.id, s, write.completedAt ?? null), lib.done(item)])
  try {
    await current(reset, v2Api.putReadingState(b.id, write), landed)
  } catch (e) {
    const err = v2Api.v2ErrorOf(e)
    const cur = (err?.current ?? null) as V2ReadingState | null
    // The one in-pass retry; a second conflict leaves the entry queued and counts as a failed attempt.
    const again = () => {
      if (retried) throw e
      return pushState(lib, host, reset, item, true)
    }
    switch (err?.code) {
      case 'stale_revision': {
        // Ours only if it holds what we sent: the same place without our completion is not that write.
        if (cur && ownStateWrite(cur, write) && (!write.completedAt || cur.completedAt)) return void (await checked(reset, () => landed(cur)))
        if (!cur) {
          await checked(reset, () => lib.setStateRevision(b.id, null, null))
          return again()
        }
        const owed = await checked(reset, () => lib.applyStates([cur], host.reader))
        owe(host, reset, owed)
        return !owed.length || owed[0].action === 'prompt' ? again() : undefined
      }
      case 'reset':
        // The reset's state: its completion (none, or a finish after the reset) replaces the one we sent.
        await checked(reset, () => lib.takeState(b.id, cur, write.completedAt ?? null))
        return again()
      case 'file_replaced':
        return void (await checked(reset, () => Promise.all([lib.setServerFile(b.id, (err.currentFile ?? null) as V2BookFile | null), lib.done(item)])))
      default:
        if (!(await refusedChild(lib, reset, item, b, err))) throw e
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
  const local = a && (await lib.book(a.book_id))
  if (!a || !local || a.deleted_at) return drop(lib, reset, item)
  const b = await pushedBook(lib, reset, local)
  if (!b) return
  const write = highlightWrite(JSON.parse(a.highlight) as PageHighlight, a.book_id, (a.file_id ?? b.file_id)!, a.revision)
  if (!write) return drop(lib, reset, item)
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
      // Lost twice: keep the server's, as for a tombstone.
      // falls through
      case 'deleted':
        return void (await checked(reset, () => Promise.all([cur ? lib.setAnnotation(cur) : null, lib.done(item)])))
      case 'id_conflict': {
        if (retried) {
          console.warn(`[v2 sync] annotation ${a.id} refused (id_conflict twice): kept on the device only`)
          return drop(lib, reset, item)
        }
        item.target = await checked(reset, () => lib.rekeyAnnotation(a.id, host.newId))
        return pushAnnotation(lib, host, reset, item, true)
      }
      default:
        if (!(await refusedChild(lib, reset, item, b, err))) throw e
    }
  }
}

/**
 * Story B5, opt-in (off by default): each pushed book whose bytes the server lacks — and that no
 * device stopped syncing (`contentRemovedAt`) — goes up through the shared `uploadV2File` to its
 * known ids. A full quota stops the round (the books stay local); offline ends the pass.
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
      if (e instanceof V2UploadNotOnServer) {
        // The server's copy of this book is not the one this device knows: push the book again
        // (sha256 first pairs it, or imports it under this device's ids), then its bytes.
        await checked(reset, () => lib.setServerFile(b.id, null))
        await bookFirst(lib, reset, b)
        continue
      }
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
  // Bytes another book here already holds: never a second local copy (books_sha256 is UNIQUE).
  if (await lib.hasLocalBytes(sha)) return false
  try {
    const staged = await current(reset, io.fetch(v2Api.contentUrl(b.id, b.server_file_id), sha))
    await checked(reset, () => io.retain(staged, sha))
    return await checked(reset, () => lib.markDownloaded(b.id))
  } catch (e) {
    if (e === DROPPED) return false
    throw e
  }
}
