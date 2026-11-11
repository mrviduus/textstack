/**
 * The web V2 reader's reader data on the server (#1226; docs/01-architecture/v2-reader-web-hosting.md S5): one
 * session per open of the production route. Online-first, no outbox: the page's entry is restored from the
 * server's reading state + this book's annotations, and each `store` is diffed (`@textstack/shared`
 * entryChanges, the mapping the Android local library uses) against what the server is known to hold, then
 * written with the expected revisions (PDD v2-sync-protocol.md "The revision rule", "Conflict codes"). A write
 * that fails stays a difference: it is written again on the next `store` and on `flush` (the tab hidden), and
 * the host is told `unsaved` until it lands. Never silent.
 *
 * Every answer lands only while the session is current: closed (another open, the host unmounted) or the
 * account store reset (`resetSince`, the shared epoch guard) drops it, and nothing more is written.
 */
import {
  annotationHighlight, entryChanges, highlightWrite, ownAnnotationWrite, ownStateWrite, pageEntry, positionWrite, statePosition, v2Api,
  type PageEntry, type PageHighlight, type PagePosition, type V2Annotation, type V2AnnotationWrite, type V2ReadingState, type V2ReadingStateWrite,
} from '@textstack/shared'
import { entryFor } from '../../../mobile/src/lib/v2reader/store.mjs'
import { pullFeed, resetSince } from '../api/v2'
import { keepalivePut } from './progressSync'

/** The open book on the server: its current file, as the page's entry names it. */
export interface V2SyncTarget {
  bookId: string
  fileId: string
  format: string
  sha256: string
  size: number
  name: string
}

export type V2SaveStatus = 'saved' | 'unsaved'

/** The server calls a session makes (the shared client's; a fake in tests). */
export interface V2ReaderSyncApi {
  getReadingState(bookId: string): Promise<V2ReadingState | null>
  /** The user's annotations (the feed is per user: filtered by book here). */
  annotations(): Promise<V2Annotation[]>
  putReadingState(bookId: string, body: V2ReadingStateWrite): Promise<V2ReadingState>
  putAnnotation(id: string, body: V2AnnotationWrite): Promise<V2Annotation>
  /** A write that outlives the page (`pagehide`); its answer is not read. */
  keepalivePutState(bookId: string, body: V2ReadingStateWrite): void
}

export const v2ReaderSyncApi: V2ReaderSyncApi = {
  getReadingState: (id) => v2Api.getReadingState(id),
  // ponytail: the whole annotations feed per open, as highlightSync; a per-book list when the API has one.
  annotations: async () => (await pullFeed<V2Annotation>('annotations')).items,
  putReadingState: v2Api.putReadingState,
  putAnnotation: v2Api.putAnnotation,
  keepalivePutState: (id, body) => void keepalivePut(v2Api.readingStateUrl(id), JSON.stringify(body)).catch(() => {}),
}

interface Held { id: string; highlight: PageHighlight | null; deleted: boolean; revision: number }

export interface V2ReaderSync {
  readonly sha256: string
  /** The page's entry for `restore` (JSON); null when the server could not be read (status `unsaved`). */
  restore(): Promise<string | null>
  /** The page's `store` payload: written to the server (one pass at a time, the latest entry wins). */
  store(json: string): void
  /** Writes what is still unsaved now (the tab hidden). */
  flush(): Promise<void>
  /** The tab is going away: the position, by a keepalive write. */
  flushKeepalive(): void
  /** Another open, or the host unmounted: nothing more lands or is written. */
  close(): void
}

export function createV2ReaderSync(t: V2SyncTarget, o: {
  onStatus(s: V2SaveStatus): void
  api?: V2ReaderSyncApi
  newId?: () => string
}): V2ReaderSync {
  const api = o.api ?? v2ReaderSyncApi
  const newId = o.newId ?? (() => crypto.randomUUID())
  const reset = resetSince()
  let closed = false
  const live = () => !closed && !reset()
  /** What the server is known to hold: the position on this file and its revision (null: a first write). */
  let position: PagePosition | null = null
  let revision: number | null = null
  const held = new Map<string, Held>()
  let latest: PageEntry | null = null
  let running: Promise<void> | null = null
  let again = false

  const status = (s: V2SaveStatus) => { if (live()) o.onStatus(s) }
  const keep = (a: V2Annotation, highlight = annotationHighlight(a)) =>
    held.set(a.id, { id: a.id, highlight, deleted: !!a.deletedAt, revision: a.revision })

  /** The position written; false when it did not land (it stays a difference). One retry after a lost revision. */
  async function pushPosition(p: PagePosition, expected: number | null, retried = false): Promise<boolean> {
    // A CBZ page (no quote) or a fraction-only position has no write the server takes: not saved.
    const write = positionWrite(p, t.fileId, expected, Date.now(), t.format)
    if (!write) return false
    try {
      const s = await api.putReadingState(t.bookId, write)
      if (live()) { position = p; revision = s.revision }
      return true
    } catch (e) {
      if (!live()) return true
      const err = v2Api.v2ErrorOf(e)
      const cur = (err?.current ?? null) as V2ReadingState | null
      if (err?.code === 'stale_revision' && cur && ownStateWrite(cur, write)) {
        position = p
        revision = cur.revision
        return true
      }
      // ADR-019 rule 5 on a lost write: a position is written only after the reader moved, so their place is
      // never adopted or moved to (`decideServerState`: a moved reader is asked; ours is written again on their
      // revision, as Android does after asking). ponytail: no "go to their place" offer on web yet.
      // `reset`: the frontier is gone, our position stays and is written on the new revision (PDD).
      // Lost twice: the next `store` or flush writes on the revision last seen.
      if (err?.code === 'stale_revision' || err?.code === 'reset') {
        revision = cur?.revision ?? null
        if (!retried) return pushPosition(p, revision, true)
      }
      console.warn('[v2 sync] position not saved:', err?.code ?? (e as Error)?.message)
      return false
    }
  }

  /** A highlight written; false when it did not land. PDD "Annotations": own write, re-apply once, a tombstone wins. */
  async function pushHighlight(h: PageHighlight, expected: number | null, retried = false): Promise<boolean> {
    const write = highlightWrite(h, t.bookId, t.fileId, expected)
    if (!write) return false
    try {
      const a = await api.putAnnotation(h.id, write)
      if (live()) keep(a, h)
      return true
    } catch (e) {
      if (!live()) return true
      const err = v2Api.v2ErrorOf(e)
      const cur = (err?.current ?? null) as V2Annotation | null
      if (err?.code === 'stale_revision' && cur && !retried && !ownAnnotationWrite(cur, write)) return pushHighlight(h, cur.revision, true)
      if ((err?.code === 'stale_revision' || err?.code === 'deleted') && cur) {
        // Own write (its answer lost): ours. Lost twice, or deleted elsewhere: the server's row is kept (a
        // tombstone is never written over; the page shows ours until the next open).
        if (ownAnnotationWrite(cur, write)) keep(cur, h)
        else keep(cur)
        return true
      }
      console.warn('[v2 sync] highlight not saved:', err?.code ?? (e as Error)?.message)
      return false
    }
  }

  async function pass() {
    const entry = latest
    if (!entry) return
    const changes = entryChanges({ position, highlights: [...held.values()] }, entry, newId)
    let saved = true
    if (changes.position && !(await pushPosition(changes.position, revision))) saved = false
    for (const { highlight } of changes.highlights) {
      if (!live()) return
      if (!(await pushHighlight(highlight, held.get(highlight.id)?.revision ?? null))) saved = false
    }
    status(saved ? 'saved' : 'unsaved')
  }

  /** One pass at a time; a `store` during one asks for one more, on the latest entry. */
  function kick(): Promise<void> {
    if (running) {
      again = true
      return running
    }
    return (running = (async () => {
      try {
        do {
          again = false
          await pass()
        } while (again && live())
      } finally {
        running = null
      }
    })())
  }

  return {
    sha256: t.sha256,
    async restore() {
      try {
        const [state, annotations] = await Promise.all([api.getReadingState(t.bookId), api.annotations()])
        if (!live()) return null
        // A state on another file version is no place in this one (a replacement deletes it, PDD rule 6).
        if (state?.fileId === t.fileId) {
          position = statePosition(state, t.format)
          revision = state.revision
        }
        // Every one of the book's rows is held (their revisions); only this file version's live ones are drawn.
        const drawn: PageHighlight[] = []
        for (const a of annotations) {
          if (a.bookId !== t.bookId) continue
          keep(a)
          const h = held.get(a.id)!.highlight
          if (h && !a.deletedAt && a.fileId === t.fileId) drawn.push(h)
        }
        return JSON.stringify(pageEntry({ sha256: t.sha256, size: t.size, name: t.name }, position, drawn))
      } catch (e) {
        console.warn('[v2 sync] reader data not loaded:', (e as Error)?.message)
        status('unsaved')
        return null
      }
    },
    store(json) {
      if (!live()) return
      const entry = entryFor(json, t)
      if (!entry) return void console.warn('[v2 sync] store: not an entry for this book')
      latest = entry
      void kick()
    },
    // A pass running already writes the latest entry: joined, not asked for again.
    flush: () => (!live() ? Promise.resolve() : running ?? kick()),
    flushKeepalive() {
      if (!live() || !latest) return
      const changes = entryChanges({ position, highlights: [] }, { position: latest.position, highlights: [] }, newId)
      const write = changes.position && positionWrite(changes.position, t.fileId, revision, Date.now(), t.format)
      if (write) api.keepalivePutState(t.bookId, write)
    },
    close() {
      closed = true
    },
  }
}
