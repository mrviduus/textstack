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
  /** Replay: PUT these — server rows edited offline, already rebased on the server row
   *  (rebaseHighlightEdit); write them to IndexedDB, then PUT replayUpdateBody(row). */
  update: StoredHighlight[]
  /** Replay: DELETE these server ids, then drop `localId` from IndexedDB. */
  remove: { serverId: string; localId: string }[]
}

/**
 * Merge a fresh server list with local IndexedDB rows. Server is the truth for
 * synced rows; local `pending` creates/deletes win and are queued for replay; pending
 * edits of server rows are three-way merged per field (rebaseHighlightEdit).
 *
 * Idempotency: POST /me/highlights has no idempotency key (server mints the id).
 * A create whose response was lost leaves a pending client-id row while the
 * server already holds it — we detect that by an identical anchor on the server
 * and adopt the server row instead of POSTing a duplicate.
 */
export function planHighlightSync(server: StoredHighlight[], local: StoredHighlight[]): HighlightSyncPlan {
  const serverById = new Map(server.map((h) => [h.id, h]))
  const serverIds = new Set(serverById.keys())
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
      const rebased = rebaseHighlightEdit(h, serverById.get(h.id)!)
      // null: every local change lost a conflict (or already matches) — the server row is stored as is.
      if (rebased) {
        plan.update.push(rebased)
        overridden.add(h.id)
      }
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

const noteKey = (n?: string | null) => n?.trim() || '' // blank == no note (the server clears on blank)

/**
 * Three-way merge of a pending offline edit onto the current server row, per field (color,
 * note), against `local.base` — the server state the edit started from:
 *  - field not edited locally → server value;
 *  - edited locally, server still equals base → local value (to be replayed);
 *  - edited locally AND changed on the server since base → conflict → server value. No
 *    "newer wins" tiebreak: the local edit time is this browser's clock, the server's
 *    `updatedAt` is the server's — not comparable, and silently overwriting another
 *    device's edit is the bug this exists to prevent.
 *
 * Returns the row rebased on `server` (base := server, version := server.version), or null
 * when no local change survives. A pending row without `base` (written before it existed)
 * merges as if the server were its base — the old last-write-wins replay.
 */
export function rebaseHighlightEdit(local: StoredHighlight, server: StoredHighlight): StoredHighlight | null {
  const base = local.base ?? { version: server.version, color: server.color, noteText: server.noteText }
  const color = local.color !== base.color && server.color === base.color ? local.color : server.color
  const noteMine =
    !!local.noteEdited &&
    noteKey(local.noteText) !== noteKey(base.noteText) &&
    noteKey(server.noteText) === noteKey(base.noteText)
  if (color === server.color && !noteMine) return null
  return {
    ...server,
    color,
    noteText: noteMine ? local.noteText : server.noteText,
    noteEdited: noteMine,
    syncStatus: 'pending',
    base: { version: server.version, color: server.color, noteText: server.noteText },
  }
}

/**
 * PUT body replaying a (rebased) pending edit: only the fields that differ from `base`,
 * conditional on `base.version` — a server change after the merge answers 409 and the sync
 * re-plans against the fresh row. The note is sent only if it was edited (`noteEdited`), so a
 * color change never erases a note written elsewhere.
 */
export function replayUpdateBody(h: StoredHighlight): UpdateHighlightData {
  if (!h.base) return h.noteEdited ? { color: h.color, noteText: h.noteText ?? null } : { color: h.color }
  const body: UpdateHighlightData = { version: h.base.version }
  if (h.color !== h.base.color) body.color = h.color
  if (h.noteEdited) body.noteText = h.noteText ?? null
  return body
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
  // A 409 (server row changed between our read and the PUT) re-plans once against a fresh list.
  syncQueue = syncQueue
    .then(() => syncOnce(bookId, isUserBook, ui))
    .then((conflict) => (conflict ? syncOnce(bookId, isUserBook, ui) : false))
    .then(() => undefined)
  return syncQueue
}

/** Resolves true when an update hit a 409 and should be re-planned. Never rejects. */
async function syncOnce(bookId: string, isUserBook: boolean, ui?: HighlightSyncUi): Promise<boolean> {
  const cancelled = () => ui?.isCancelled() ?? false
  let conflict = false
  try {
    const serverHighlights = isUserBook ? await getUserBookHighlights(bookId) : await getPublicHighlights(bookId)
    if (cancelled()) return false

    const local = isUserBook ? await getHighlightsForUserBook(bookId) : await getHighlightsForEdition(bookId)
    const plan = planHighlightSync(serverHighlights.map(fromServerHighlight), local)

    // Reconcile, don't wipe-and-rebuild (see git history: a wipe window
    // could leave IndexedDB empty on navigation).
    for (const h of plan.store) await saveHighlight(h)
    for (const h of plan.update) await saveHighlight(h) // rebased: a failed PUT replays the merge, not the stale edit
    for (const id of plan.drop) await deleteHighlightFromDB(id)
    if (cancelled()) return false
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
        if (err instanceof ApiError && err.status === 409) conflict = true // stays pending; re-planned
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
  return conflict
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
