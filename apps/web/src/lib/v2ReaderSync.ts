/**
 * The web V2 reader's reader data on the server (#1226; docs/01-architecture/v2-reader-web-hosting.md S5): one
 * session per open of the production route. Online-only, no outbox:
 * - **No reading-state read, no session.** `restore` throws when the state cannot be read (the host offers a
 *   retry); the page is restored only from the server's place, so nothing is ever written over a place unseen.
 * - **No annotations pull, no highlight writes.** The book's annotations are drawn when their pull lands
 *   (`onHighlights`); until then highlights are held, the host offers none, and the status says so; the pull
 *   is retried on the next `store` and flush. The position never waits for it. A book without highlights
 *   (`highlights: false`: a PDF, a CBZ) pulls nothing.
 * - Each `store` is diffed (`@textstack/shared` entryChanges, the mapping the Android local library uses)
 *   against what the server is known to hold and written with the expected revisions (PDD v2-sync-protocol.md
 *   "The revision rule", "Conflict codes"). A failed write stays a difference, written again on the next
 *   `store` and on flush (the tab hidden), `unsaved` until it lands; `pagehide` sends what is left by keepalive.
 * - A refusal no retry changes: the book's file changed → no more writes, `reopen`; the write itself refused →
 *   not resent until the page changes it, `unsaved` meanwhile. Never silent, no request per page turn.
 * - Another device's place on a lost write (#1232): ADR-019 by `decideServerState` against this tab's last saved
 *   (or restored) place, as Android. `adopt`/`move` take theirs (the host moves the page); `keep` and `prompt` write
 *   ours on their revision, and `prompt` offers theirs (`onNewerPlace`). No write is ever held for an answer.
 *
 * The one local exception: a CBZ page position (no server form yet, #1188) is kept in this browser per book.
 *
 * Answers land while the session is live; the host is told nothing once it is closing (another open, the host
 * unmounted), and nothing lands once the account store reset (`resetSince`, the shared epoch guard).
 */
import {
  annotationHighlight, ApiError, entryChanges, entryFor, highlightWrite, isImagePage, normalisedHighlight, ownAnnotationWrite,
  decideServerState, ownStateWrite, pageEntry, positionWrite, sameJson, statePosition, v2Api,
  type HeldHighlight, type OpenReader, type PageEntry, type PageHighlight, type PagePosition, type V2Annotation, type V2AnnotationWrite, type V2ReadingState,
  type V2ReadingStateWrite,
} from '@textstack/shared'
import { resetSince } from '../api/v2'
import { keepalivePut } from './progressSync'
import { readItem, writeItem } from './safeLocalStorage'

/** The open book on the server: its current file, as the page's entry names it. */
export interface V2SyncTarget {
  bookId: string
  fileId: string
  format: string
  sha256: string
  size: number
  name: string
}

/**
 * `reopen`: the book's file changed on the server, reopening reads the new one. `noHighlights`: the annotations
 * are not loaded yet (highlighting is not offered).
 */
export type V2SaveStatus = 'saved' | 'unsaved' | 'reopen' | 'noHighlights'

/** The server calls a session makes (the shared client's; a fake in tests). */
export interface V2ReaderSyncApi {
  getReadingState(bookId: string): Promise<V2ReadingState | null>
  /** The user's annotations (the feed is per user: filtered by book here). */
  annotations(): Promise<V2Annotation[]>
  putReadingState(bookId: string, body: V2ReadingStateWrite): Promise<V2ReadingState>
  putAnnotation(id: string, body: V2AnnotationWrite): Promise<V2Annotation>
  /** Writes that outlive the page (`pagehide`); their answers are not read. */
  keepalivePutState(bookId: string, body: string): void
  keepalivePutAnnotation(id: string, body: string): void
}

export const v2ReaderSyncApi: V2ReaderSyncApi = {
  getReadingState: (id) => v2Api.getReadingState(id),
  // A fresh pull, never one in flight (pullFeed's): a reopen must see the previous session's writes.
  // ponytail: the whole annotations feed per open, as highlightSync; a per-book list when the API has one.
  annotations: async () => (await v2Api.pullAll<V2Annotation>('annotations')).items,
  putReadingState: v2Api.putReadingState,
  putAnnotation: v2Api.putAnnotation,
  keepalivePutState: (id, body) => void keepalivePut(v2Api.readingStateUrl(id), body).catch(() => {}),
  keepalivePutAnnotation: (id, body) => void keepalivePut(v2Api.annotationUrl(id), body).catch(() => {}),
}

/** The browser's keepalive budget is 64 KiB for every request in flight; headroom kept. */
export const KEEPALIVE_BUDGET = 60_000

/** A CBZ page position, kept in this browser (#1188). */
const imagePageKey = (bookId: string) => `v2reader:cbz-position:${bookId}`

/** The last session of each book still writing: the next one of that book reads after it, whatever was open between. */
const closingByBook = new Map<string, Promise<void>>()

interface Held extends HeldHighlight { revision: number | null }

export interface V2ReaderSync {
  readonly target: V2SyncTarget
  /** The page's entry for `restore` (JSON, the position only); null when closed meanwhile. Throws when the state cannot be read. */
  restore(): Promise<string | null>
  /** The annotations pull: `onHighlights` when it lands, `noHighlights` when it fails (retried by store/flush). */
  loadHighlights(): Promise<void>
  /** The page's `store` payload: written to the server (one pass at a time, the latest entry wins). */
  store(json: string): void
  /** Writes what is still unsaved now (the tab hidden). */
  flush(): Promise<void>
  /** The tab is going away: what is unsaved, by keepalive writes (the position first, within the budget). */
  flushKeepalive(): void
  /** Another open, or the host unmounted: one last pass of what is unsaved, then nothing more is written. */
  close(): Promise<void>
}

const errorCode = (e: unknown) => v2Api.v2ErrorOf(e)?.code ?? (e as Error | null)?.message
/** The book's file is not what this session reads any more: no write of this open can land. */
const BOOK_GONE = new Set(['file_replaced', 'unknown_file', 'book_not_found'])
/** This write as sent is refused for good: not resent until the page changes it. */
const refusedAsSent = (e: unknown) => {
  const code = v2Api.v2ErrorOf(e)?.code
  return code === 'invalid_payload' || code === 'chapter_not_found' || (e instanceof ApiError && (e.status === 400 || e.status === 422))
}
/** `h` as the page's form held in `m` (compared as normalised). */
const isHeldAs = (m: Map<string, PageHighlight>, h: PageHighlight) => {
  const x = m.get(h.id)
  return !!x && sameJson(x, normalisedHighlight(h))
}

export function createV2ReaderSync(t: V2SyncTarget, o: {
  onStatus(s: V2SaveStatus): void
  /** This file's live highlights, once the pull lands: the host draws them and offers highlighting. */
  onHighlights(list: PageHighlight[]): void
  /** The open page as ADR-019 sees it (`decideServerState`). */
  reader(): OpenReader | null
  /** Another device's newer place: `ask` false, taken (the host moves the page there, nothing saved); true, offered (ours is written anyway). */
  onNewerPlace(p: PagePosition, ask: boolean): void
  /** Waited for before the first read; by default the last session of this book still writing (a reopen). */
  after?: Promise<unknown>
  /** False where the page offers no highlights (a PDF, a CBZ): no annotations pull. */
  highlights?: boolean
  api?: V2ReaderSyncApi
  newId?: () => string
}): V2ReaderSync {
  const api = o.api ?? v2ReaderSyncApi
  const newId = o.newId ?? (() => crypto.randomUUID())
  const reset = resetSince()
  let closed = false
  let closing: Promise<void> | null = null
  /** Answers may land (the session's own bookkeeping). */
  const live = () => !closed && !reset()
  /** The host may be told (not closing). */
  const current = () => live() && !closing
  /** The reading state was read and the page restored from it: only then is a `store` taken (`latest`). */
  let ready = false
  let highlightsLoaded = o.highlights === false
  const after = o.after ?? closingByBook.get(t.bookId)
  let pulling: Promise<void> | null = null
  /** The book's file changed on the server: nothing more is written this open. */
  let gone = false
  /** What the server is known to hold: the position on this file and its revision (null: a first write). */
  let position: PagePosition | null = null
  let revision: number | null = null
  const held = new Map<string, Held>()
  /** Page forms not written again until the page changes them: the server's won (saved), or the write was refused (unsaved). */
  const overridden = new Map<string, PageHighlight>()
  const refused = new Map<string, PageHighlight>()
  let refusedPosition: PagePosition | null = null
  let latest: PageEntry | null = null
  let running: Promise<void> | null = null
  let again = false

  const status = (s: V2SaveStatus) => { if (current()) o.onStatus(s) }
  const keep = (a: V2Annotation, highlight = annotationHighlight(a)) =>
    held.set(a.id, { id: a.id, highlight, fileId: a.fileId, deleted: !!a.deletedAt, revision: a.revision })

  /** The position written; false when it did not land or was refused. One retry after a lost revision. */
  async function pushPosition(p: PagePosition, expected: number | null, retried = false): Promise<boolean> {
    // A fraction-only position has no write the server takes (and a CBZ page never reaches here).
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
      // ADR-019 rule 5 on a lost write (#1232), as Android: decided against the place this tab last saved or restored
      // (`position`), never the move being written (always the newest). `adopt`/`move`: theirs is what the server holds
      // and what the page shows (no store follows a host move). `keep`, `prompt` (theirs offered) and `reset` (the
      // frontier is gone, our position stays: PDD): ours again on their revision. Lost twice: the next `store` or flush
      // writes on the revision last seen.
      if (err?.code === 'stale_revision' || err?.code === 'reset') {
        revision = cur?.revision ?? null
        const theirs = err.code === 'stale_revision' && cur ? statePosition(cur, t.format) : null
        const action = theirs && cur ? decideServerState({ local: position, localFileId: t.fileId, server: cur, reader: o.reader(), format: t.format }) : 'keep'
        if (theirs && action !== 'keep' && current()) o.onNewerPlace(theirs, action === 'prompt')
        if (theirs && (action === 'adopt' || action === 'move')) {
          position = theirs
          if (latest) latest = { ...latest, position: theirs }
          return true
        }
        if (!retried) return pushPosition(p, revision, true)
      } else if (err && BOOK_GONE.has(err.code)) gone = true
      // Held as sent so it is not resent; unsaved until the reader moves.
      else if (refusedAsSent(e)) position = refusedPosition = p
      console.warn('[v2 sync] position not saved:', errorCode(e))
      return false
    }
  }

  /**
   * A highlight written; false when it did not land or was refused. PDD "Annotations": own write, re-apply once,
   * a tombstone wins. `pageId`: the id the page holds it under (another after an `id_conflict` re-key).
   */
  async function pushHighlight(h: PageHighlight, expected: number | null, retried = false, pageId = h.id): Promise<boolean> {
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
      const pageForm = { ...h, id: pageId }
      if (err?.code === 'stale_revision' && cur && !retried && !ownAnnotationWrite(cur, write)) return pushHighlight(h, cur.revision, true, pageId)
      if ((err?.code === 'stale_revision' || err?.code === 'deleted') && cur) {
        if (ownAnnotationWrite(cur, write)) {
          keep(cur, h)
          return true
        }
        // Lost twice, or deleted elsewhere: the server's row is kept, and the page's form (still on screen until the
        // next open) is not written over it again until the reader changes it.
        keep(cur)
        overridden.set(pageId, pageForm)
        return true
      }
      // The id is someone else's (PDD `id_conflict`): a new one, once. The page keeps the old id; the same CFI +
      // text under the new one is its twin (entryChanges), so it is not sent again.
      if (err?.code === 'id_conflict' && !retried) return pushHighlight({ ...h, id: newId() }, null, true, pageId)
      if (err && BOOK_GONE.has(err.code)) gone = true
      else if (refusedAsSent(e) || err?.code === 'id_conflict') refused.set(pageId, pageForm)
      console.warn('[v2 sync] highlight not saved:', errorCode(e))
      return false
    }
  }

  /** The changes the latest entry makes, highlights held as the page has them (overridden, refused) left out. */
  function changesOf(entry: PageEntry) {
    const highlights = entry.highlights.filter((h) => !isHeldAs(overridden, h) && !isHeldAs(refused, h))
    return entryChanges(t.fileId, { position, highlights: [...held.values()] }, { position: entry.position, highlights }, newId)
  }

  async function pass() {
    if (gone) return
    // Not waited for: the position is written now, the highlights by one more pass when the pull lands.
    if (!highlightsLoaded) void loadHighlights().then(() => { if (highlightsLoaded && latest && current()) void kick() })
    if (!latest) return
    const changes = changesOf(latest)
    let saved = true
    if (changes.position) {
      if (isImagePage(changes.position)) {
        writeItem(imagePageKey(t.bookId), JSON.stringify(changes.position))
        position = changes.position
      } else if (!(await pushPosition(changes.position, revision))) saved = false
    }
    // Highlight writes wait for the pull: without the server's rows a write would duplicate or overwrite one.
    if (highlightsLoaded) {
      for (const { highlight } of changes.highlights) {
        if (!live() || gone) break
        if (!(await pushHighlight(highlight, held.get(highlight.id)?.revision ?? null))) saved = false
      }
    }
    // A refused value the page still holds stays unsaved, though it is not resent.
    const stuck = (!!refusedPosition && sameJson(refusedPosition, latest.position)) || latest.highlights.some((h) => isHeldAs(refused, h))
    status(gone ? 'reopen' : !saved || stuck ? 'unsaved' : highlightsLoaded ? 'saved' : 'noHighlights')
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
        } while (again && live() && !gone)
      } finally {
        running = null
      }
    })())
  }

  function loadHighlights(): Promise<void> {
    if (highlightsLoaded || !current()) return Promise.resolve()
    return (pulling ??= (async () => {
      try {
        const annotations = await api.annotations()
        if (!live()) return
        // Every one of the book's rows is held (their revisions); only this file version's live ones are drawn.
        const drawn: PageHighlight[] = []
        for (const a of annotations) {
          if (a.bookId !== t.bookId) continue
          keep(a)
          const h = held.get(a.id)!.highlight
          if (h && !a.deletedAt && a.fileId === t.fileId) drawn.push(h)
        }
        highlightsLoaded = true
        if (current()) o.onHighlights(drawn)
      } catch (e) {
        console.warn('[v2 sync] highlights not loaded:', errorCode(e))
        status('noHighlights')
      } finally {
        pulling = null
      }
    })())
  }

  return {
    target: t,
    async restore() {
      await after?.catch(() => {})
      if (!current()) return null
      const s = await api.getReadingState(t.bookId)
      if (!current()) return null
      const onFile = s?.fileId === t.fileId ? s : null
      revision = onFile?.revision ?? null
      // A CBZ page lives in this browser only (#1188).
      position = t.format === 'cbz' ? imagePage(t.bookId) : onFile && statePosition(onFile, t.format)
      ready = true
      return JSON.stringify(pageEntry({ sha256: t.sha256, size: t.size, name: t.name }, position, []))
    },
    loadHighlights,
    store(json) {
      if (!current() || !ready) return
      const entry = entryFor(json, t)
      if (!entry) return void console.warn('[v2 sync] store: not an entry for this book')
      latest = entry
      void kick()
    },
    // A pass running already writes the latest entry: joined, not asked for again.
    flush: () => (!current() ? Promise.resolve() : running ?? kick()),
    flushKeepalive() {
      if (!live() || gone || !latest) return
      const changes = changesOf(latest)
      // A CBZ page a pass has not kept yet (one was running).
      if (changes.position && isImagePage(changes.position)) writeItem(imagePageKey(t.bookId), JSON.stringify(changes.position))
      const bodies: [send: (body: string) => void, body: string][] = []
      // ponytail: a position PUT still in flight on the same revision makes this one lose (stale_revision, never
      // read): on a slow link the last page turn before closing the tab can be lost; the next open is one turn back.
      const write = changes.position && positionWrite(changes.position, t.fileId, revision, Date.now(), t.format)
      if (write) bodies.push([(b) => api.keepalivePutState(t.bookId, b), JSON.stringify(write)])
      if (highlightsLoaded) {
        for (const { highlight: h } of changes.highlights) {
          const w = highlightWrite(h, t.bookId, t.fileId, held.get(h.id)?.revision ?? null)
          if (w) bodies.push([(b) => api.keepalivePutAnnotation(h.id, b), JSON.stringify(w)])
        }
      }
      // The position first, then highlights, while the budget lasts.
      let left = KEEPALIVE_BUDGET
      for (const [send, body] of bodies) {
        const size = new TextEncoder().encode(body).length
        if (size > left) break
        left -= size
        send(body)
      }
    },
    close() {
      if (closing) return closing
      const done = closing = (running ?? (latest && !gone ? kick() : Promise.resolve())).catch(() => {}).finally(() => {
        closed = true
        if (closingByBook.get(t.bookId) === done) closingByBook.delete(t.bookId)
      })
      closingByBook.set(t.bookId, done)
      return done
    },
  }
}

function imagePage(bookId: string): PagePosition | null {
  try {
    const p = JSON.parse(readItem(imagePageKey(bookId)) ?? 'null')
    return isImagePage(p) ? p : null
  } catch {
    return null
  }
}
