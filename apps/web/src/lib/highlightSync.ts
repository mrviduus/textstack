import {
  type StoredHighlight,
  type HighlightAnchor,
  type HighlightColor,
  getHighlightsForEdition,
  getHighlightsForUserBook,
  getAllStoredHighlights,
  saveHighlight,
  deleteHighlight as deleteHighlightFromDB,
} from './offlineDb'
import {
  type PublicHighlight,
  getPublicHighlights,
  getUserBookHighlights,
  createPublicHighlight,
  updatePublicHighlight,
  deletePublicHighlight,
} from '../api/userData'
import type { UpdateHighlightData } from '@textstack/shared'
import { ApiError } from '../api/client'
import { emitDataChange } from './dataEvents'

/**
 * A highlight created offline carries a client id (`<ms>-<rand>`); the server
 * mints GUIDs. That difference is how we tell "never reached the server" from
 * "server row with a pending edit".
 */
export function isLocalHighlightId(id: string): boolean {
  return /^\d+-[a-z0-9]+$/.test(id)
}

export function fromServerHighlight(sh: PublicHighlight): StoredHighlight {
  return {
    id: sh.id,
    editionId: sh.editionId || '',
    chapterId: sh.chapterId || '',
    userBookId: sh.userBookId || undefined,
    userChapterId: sh.userChapterId || undefined,
    anchor: JSON.parse(sh.anchorJson) as HighlightAnchor,
    color: sh.color as HighlightColor,
    selectedText: sh.selectedText,
    noteText: sh.noteText ?? undefined,
    syncStatus: 'synced',
    version: sh.version,
    createdAt: new Date(sh.createdAt).getTime(),
    updatedAt: new Date(sh.updatedAt).getTime(),
  }
}

// The server stores anchorJson as jsonb, which reorders keys — compare canonically.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

const anchorKey = (h: StoredHighlight) => canonical(h.anchor)

export interface HighlightSyncPlan {
  /** What the reader should see, newest first. */
  visible: StoredHighlight[]
  /** Server rows to write to IndexedDB (none that a local pending row overrides). */
  store: StoredHighlight[]
  /** Local rows to delete from IndexedDB. */
  drop: string[]
  /** Replay: POST these (client-id rows the server has never seen). */
  create: StoredHighlight[]
  /** Replay: PUT these (server rows edited offline; local wins). */
  update: StoredHighlight[]
  /** Replay: DELETE these server ids, then drop `localId` from IndexedDB. */
  remove: { serverId: string; localId: string }[]
}

/**
 * Merge a fresh server list with local IndexedDB rows. Server is the truth for
 * synced rows; local `pending` rows win and are queued for replay.
 *
 * Idempotency: POST /me/highlights has no idempotency key (server mints the id).
 * A create whose response was lost leaves a pending client-id row while the
 * server already holds it — we detect that by an identical anchor on the server
 * and adopt the server row instead of POSTing a duplicate.
 */
export function planHighlightSync(server: StoredHighlight[], local: StoredHighlight[]): HighlightSyncPlan {
  const serverIds = new Set(server.map((h) => h.id))
  const serverByAnchor = new Map(server.map((h) => [anchorKey(h), h]))
  const plan: HighlightSyncPlan = { visible: [], store: [], drop: [], create: [], update: [], remove: [] }
  const overridden = new Set<string>()

  for (const h of local) {
    if (h.syncStatus !== 'pending') {
      if (!serverIds.has(h.id)) plan.drop.push(h.id) // deleted elsewhere
      continue
    }
    const onServer = serverIds.has(h.id)
    const twin = !onServer && isLocalHighlightId(h.id) ? serverByAnchor.get(anchorKey(h)) : undefined

    if (h.deleted) {
      const serverId = onServer ? h.id : twin?.id
      if (serverId) {
        plan.remove.push({ serverId, localId: h.id })
        overridden.add(serverId)
      } else {
        plan.drop.push(h.id)
      }
    } else if (onServer) {
      plan.update.push(h)
      overridden.add(h.id)
    } else if (twin) {
      plan.drop.push(h.id) // lost-response create: server already has it
    } else if (isLocalHighlightId(h.id)) {
      plan.create.push(h)
    } else {
      plan.drop.push(h.id) // edited offline, deleted elsewhere meanwhile
    }
  }

  plan.store = server.filter((h) => !overridden.has(h.id))
  plan.visible = [...plan.store, ...plan.update, ...plan.create].sort((a, b) => b.createdAt - a.createdAt)
  return plan
}

/**
 * PUT body replaying a pending offline edit. No `version`: the offline edit is the
 * reader's latest intent (last write wins). The note is sent only if it was edited
 * offline (`noteEdited`) — otherwise a color-only change would overwrite, or with
 * `removeNote` erase, a note written on another device meanwhile.
 */
export function replayUpdateBody(h: StoredHighlight): UpdateHighlightData {
  return h.noteEdited ? { color: h.color, noteText: h.noteText ?? null } : { color: h.color }
}

export interface HighlightSyncUi {
  isCancelled: () => boolean
  /** The merged list to show, before replay starts. */
  onVisible: (list: StoredHighlight[]) => void
  /** A replayed row was replaced by its server version. */
  onReplaced: (oldId: string, saved: StoredHighlight) => void
}

// One queue for every caller (reader hook + post-sign-in replay): each run re-reads
// IndexedDB after the previous one finished, so no pending row is POSTed twice.
let syncQueue: Promise<void> = Promise.resolve()

/**
 * Fetch one book's server list, merge with local pending rows (local pending wins),
 * then replay pending creates/updates/deletes. A failed replay leaves the row pending
 * for the next run — never discarded. Server unavailable → local data kept. Never rejects.
 */
export function syncBookHighlights(bookId: string, isUserBook: boolean, ui?: HighlightSyncUi): Promise<void> {
  syncQueue = syncQueue.then(() => syncOnce(bookId, isUserBook, ui))
  return syncQueue
}

async function syncOnce(bookId: string, isUserBook: boolean, ui?: HighlightSyncUi): Promise<void> {
  const cancelled = () => ui?.isCancelled() ?? false
  try {
    const serverHighlights = isUserBook ? await getUserBookHighlights(bookId) : await getPublicHighlights(bookId)
    if (cancelled()) return

    const local = isUserBook ? await getHighlightsForUserBook(bookId) : await getHighlightsForEdition(bookId)
    const plan = planHighlightSync(serverHighlights.map(fromServerHighlight), local)

    // Reconcile, don't wipe-and-rebuild (see git history: a wipe window
    // could leave IndexedDB empty on navigation).
    for (const h of plan.store) await saveHighlight(h)
    for (const id of plan.drop) await deleteHighlightFromDB(id)
    if (cancelled()) return
    ui?.onVisible(plan.visible)

    let changed = false
    for (const h of plan.create) {
      try {
        const created = fromServerHighlight(
          await createPublicHighlight(
            h.userBookId
              ? {
                  userBookId: h.userBookId,
                  userChapterId: h.userChapterId,
                  anchorJson: JSON.stringify(h.anchor),
                  color: h.color,
                  selectedText: h.selectedText,
                  noteText: h.noteText,
                }
              : {
                  editionId: h.editionId,
                  chapterId: h.chapterId,
                  anchorJson: JSON.stringify(h.anchor),
                  color: h.color,
                  selectedText: h.selectedText,
                  noteText: h.noteText,
                }
          )
        )
        await saveHighlight(created)
        await deleteHighlightFromDB(h.id)
        if (!cancelled()) ui?.onReplaced(h.id, created)
        changed = true
      } catch {
        // stays pending
      }
    }
    for (const h of plan.update) {
      try {
        const saved = fromServerHighlight(await updatePublicHighlight(h.id, replayUpdateBody(h)))
        await saveHighlight(saved)
        if (!cancelled()) ui?.onReplaced(h.id, saved)
        changed = true
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) await deleteHighlightFromDB(h.id)
      }
    }
    for (const { serverId, localId } of plan.remove) {
      try {
        await deletePublicHighlight(serverId)
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) continue // stays pending
      }
      await deleteHighlightFromDB(localId)
      changed = true
    }
    if (changed) emitDataChange('highlights')
  } catch {
    // Server unavailable, keep local data.
  }
}

/** Books (edition or upload) holding at least one pending local row. */
export function booksWithPending(local: StoredHighlight[]): { bookId: string; isUserBook: boolean }[] {
  const books = new Map<string, { bookId: string; isUserBook: boolean }>()
  for (const h of local) {
    if (h.syncStatus !== 'pending') continue
    const book = h.userBookId ? { bookId: h.userBookId, isUserBook: true } : { bookId: h.editionId, isUserBook: false }
    if (book.bookId) books.set(`${book.isUserBook}:${book.bookId}`, book)
  }
  return [...books.values()]
}

/**
 * Replay every pending highlight in IndexedDB, across all books. Called after sign-in /
 * registration: highlights made without a session would otherwise wait until the reader
 * reopened that particular book. Never rejects.
 */
export async function replayAllPendingHighlights(): Promise<void> {
  try {
    for (const { bookId, isUserBook } of booksWithPending(await getAllStoredHighlights())) {
      await syncBookHighlights(bookId, isUserBook)
    }
  } catch {
    // IndexedDB unavailable — the reader hook still replays per book on next open.
  }
}
