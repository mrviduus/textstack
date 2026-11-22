import {
  type StoredHighlight,
  type HighlightAnchor,
  type HighlightColor,
  getHighlightsForUserBook,
  getAllStoredHighlights,
  saveHighlight,
  deleteHighlight as deleteHighlightFromDB,
} from './offlineDb'
import { emitDataChange } from './dataEvents'
import {
  isPdfAnchor, syncApi, clip, anchorToLocator, locatorToAnchor, MAX_SELECTED_TEXT, type Annotation, type AnnotationWrite,
} from '@textstack/shared'
import { v2Book, pullFeed, v2Store, resetSince, whileCurrent } from '../api/v2'

export interface HighlightSyncUi {
  isCancelled: () => boolean
  /** The merged list to show, before replay starts. */
  onVisible: (list: StoredHighlight[]) => void
}

// One queue for every caller: each run re-reads IndexedDB after the previous one finished,
// so no pending row is sent twice.
let syncQueue: Promise<void> = Promise.resolve()

/**
 * Pull one upload's annotations, merge with local pending rows, then replay pending
 * creates/updates/deletes. A failed replay leaves the row pending for the next run.
 * Server unavailable → local data kept. Never rejects.
 */
export function syncBookHighlights(bookId: string, ui?: HighlightSyncUi, pushOnly = false): Promise<void> {
  syncQueue = syncQueue.then(() => syncOnceV2(bookId, ui, pushOnly)).then(() => undefined)
  return syncQueue
}

/** Uploads holding at least one pending local row (a catalog edition's rows have no route: skipped). */
export function booksWithPending(local: StoredHighlight[]): string[] {
  return [...new Set(local.filter((h) => h.syncStatus === 'pending' && h.userBookId).map((h) => h.userBookId!))]
}

/**
 * Replay every pending highlight in IndexedDB, across all books. Called after sign-in /
 * registration. Never rejects.
 */
export async function replayAllPendingHighlights(): Promise<void> {
  try {
    for (const bookId of booksWithPending(await getAllStoredHighlights())) await syncBookHighlights(bookId)
  } catch {
    // IndexedDB unavailable.
  }
}

// ---- V2 (#1025): a user book's highlights on /me/v2/annotations ----------------------------------
// IndexedDB stays the cache; a highlight's id is its own client uuid and `version` is the V2 revision.

/** A V2 annotation as the reader stores it; null when this reader cannot draw it (an `epub-cfi`, or none). */
export function fromV2Annotation(a: Annotation): StoredHighlight | null {
  const anchor: HighlightAnchor | null = locatorToAnchor(a.locator)
  if (!anchor) return null
  const chapterId = isPdfAnchor(anchor) ? '' : anchor.chapterId
  return {
    id: a.id,
    editionId: '',
    chapterId,
    userBookId: a.bookId,
    userChapterId: chapterId || undefined,
    anchor,
    color: a.color as HighlightColor,
    selectedText: a.selectedText,
    noteText: a.noteText ?? undefined,
    syncStatus: 'synced',
    version: a.revision,
    createdAt: Date.parse(a.createdAt),
    updatedAt: Date.parse(a.updatedAt),
  }
}

/**
 * `stored`: the server's row. An edit never moves a highlight (a note or a color), so its locator and
 * file go back unchanged: a migrated anchor may have no offsets, which `anchorToLocator` refuses,
 * and the file may since have been replaced.
 */
export function toV2Write(h: StoredHighlight, fileId: string | null, expectedRevision: number | null, stored?: Annotation): AnnotationWrite {
  return {
    expectedRevision,
    bookId: h.userBookId!,
    fileId: stored ? stored.fileId : fileId,
    selectedText: clip(h.selectedText, MAX_SELECTED_TEXT),
    noteText: h.noteText?.trim() ? h.noteText : null,
    locator: stored ? stored.locator : anchorToLocator(h.anchor),
    color: h.color,
  }
}

/**
 * Server rows replace synced local ones; pending rows are pushed: a
 * create (unknown to the server) with `expectedRevision` null, an edit on the revision it was made from, a tombstone as a DELETE. 409 `stale_revision` adopts the server's
 * row; `deleted` deletes locally (a tombstone wins); `chapter_not_found` drops the write (the
 * file's chapters changed). Other failures leave the row pending. Never rejects, never re-plans.
 * `pushOnly` (a highlight added, edited or deleted in the reader) replays against what the last
 * pull and writes left, without pulling the feed again; the open and every other replay pull.
 */
async function syncOnceV2(bookId: string, ui?: HighlightSyncUi, pushOnly = false): Promise<boolean> {
  const cancelled = () => ui?.isCancelled() ?? false
  // Signed out (or another account) mid-sync: the rest of this sync is the previous account's (#1155).
  const reset = resetSince()
  try {
    const fileId = (await v2Book(bookId)).currentFile?.id ?? null
    const pull = !pushOnly || !v2Store.pulled.has(bookId)
    if (pull) {
      // ponytail: the feed is per user, filtered here; a per-book list when one exists.
      const feed = await whileCurrent(pullFeed<Annotation>('annotations'), ({ items }) => {
        for (const a of items) v2Store.annotations.set(a.id, a)
        v2Store.pulled.add(bookId)
      }, reset)
      if (!feed) return false
    }
    if (cancelled()) return false
    const server = [...v2Store.annotations.values()].filter((a) => a.bookId === bookId)
    const serverById = new Map(server.map((a) => [a.id, a]))
    const local = await getHighlightsForUserBook(bookId)
    const pending = new Set(local.filter((h) => h.syncStatus === 'pending').map((h) => h.id))

    // Every local write below goes through adopt or forget, and every request waits for live():
    // after a reset none happens, and the throw ends the sync (the outer catch).
    const live = () => {
      if (reset()) throw new syncApi.SessionChangedError()
    }
    const forget = (id: string) => {
      live()
      return deleteHighlightFromDB(id)
    }
    const adopt = async (a: Annotation) => {
      live()
      v2Store.annotations.set(a.id, a)
      const row = a.deletedAt ? null : fromV2Annotation(a)
      if (row) await saveHighlight(row)
      else await forget(a.id)
    }
    if (pull) {
      for (const a of server) if (!pending.has(a.id)) await adopt(a)
      for (const h of local) if (!pending.has(h.id) && !serverById.has(h.id)) await forget(h.id)
    }

    // A write V2 refuses (an anchor without offsets, #1139) is refused on every replay: an edit of a
    // server row reverts to the server's copy, a local-only create is dropped. Never retried.
    const refused = async (h: StoredHighlight, stored: Annotation | undefined, why: unknown) => {
      console.warn('highlightSync: V2 refuses this highlight write', h.id, why)
      if (stored) await adopt(stored)
      else await forget(h.id)
    }

    let changed = false
    for (const h of local.filter((l) => pending.has(l.id))) {
      // A reset during the last row's local write: this row's request would go out under the next account.
      live()
      const stored = serverById.get(h.id)
      try {
        if (h.deleted || stored?.deletedAt) {
          if (h.deleted && stored && !stored.deletedAt) await adopt(await syncApi.deleteAnnotation(h.id))
          else await forget(h.id)
        } else {
          let write: AnnotationWrite | undefined
          try { write = toV2Write(h, fileId, stored ? (h.base?.version ?? h.version) : null, stored) } catch (e) { await refused(h, stored, e) }
          if (write) await adopt(await syncApi.putAnnotation(h.id, write))
        }
        changed = true
      } catch (e) {
        const err = syncApi.syncErrorOf(e)
        if ((err?.code === 'stale_revision' || err?.code === 'deleted') && err.current) await adopt(err.current as Annotation)
        else if (err?.code === 'chapter_not_found' || err?.code === 'not_found') await forget(h.id)
        else if (err?.code === 'invalid_payload') await refused(h, stored, err)
        else continue // stays pending
        changed = true
      }
    }
    if (changed) emitDataChange('highlights')
    if (!cancelled()) {
      const visible = (await getHighlightsForUserBook(bookId)).filter((h) => !h.deleted)
      ui?.onVisible(visible.sort((a, b) => b.createdAt - a.createdAt))
    }
  } catch {
    // Server unavailable (or V2 paused, 503), or signed out meanwhile: keep local data.
  }
  return false
}
