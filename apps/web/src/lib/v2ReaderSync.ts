/**
 * The web V2 reader's reader data on the server (#1226; docs/01-architecture/v2-reader-web-hosting.md S5): one
 * session per open of the production route. Online-first, no outbox: the page is restored from the server's
 * reading state first, the book's annotations are drawn when their pull lands, and each `store` is diffed
 * (`@textstack/shared` entryChanges, the mapping the Android local library uses) against what the server is
 * known to hold, then written with the expected revisions (PDD v2-sync-protocol.md "The revision rule",
 * "Conflict codes"). A write that fails stays a difference: written again on the next `store` and on `flush`
 * (the tab hidden), with `unsaved` until it lands; `pagehide` sends what is left by keepalive. Never silent.
 *
 * No position is written before the server's reading state has been read: a write on an unknown revision
 * would replace the server's place unseen. A refusal no retry can change ends the session's writes
 * (`reopen`: the book's file changed) or drops that one write (`invalid_payload` and kin).
 *
 * The one local exception: a CBZ page position (no server form yet, #1188) is kept in this browser per book.
 *
 * Answers land while the session is live; the host is told nothing once it is closing (another open, the host
 * unmounted), and nothing lands once the account store reset (`resetSince`, the shared epoch guard).
 */
import {
  annotationHighlight, ApiError, decideServerState, entryChanges, entryFor, highlightWrite, isImagePage, normalisedHighlight, ownAnnotationWrite,
  ownStateWrite, pageEntry, positionWrite, sameJson, statePosition, v2Api,
  type HeldHighlight, type PageEntry, type PageHighlight, type PagePosition, type V2Annotation, type V2AnnotationWrite, type V2ReadingState,
  type V2ReadingStateWrite,
} from '@textstack/shared'
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

/** `reopen`: the server refused this book's writes for good (its file changed): reopening it reads the new one. */
export type V2SaveStatus = 'saved' | 'unsaved' | 'reopen'

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
  // ponytail: the whole annotations feed per open, as highlightSync; a per-book list when the API has one.
  annotations: async () => (await pullFeed<V2Annotation>('annotations')).items,
  putReadingState: v2Api.putReadingState,
  putAnnotation: v2Api.putAnnotation,
  keepalivePutState: (id, body) => void keepalivePut(v2Api.readingStateUrl(id), body).catch(() => {}),
  keepalivePutAnnotation: (id, body) => void keepalivePut(v2Api.annotationUrl(id), body).catch(() => {}),
}

/** The browser's keepalive budget is 64 KiB for every request in flight; headroom kept. */
export const KEEPALIVE_BUDGET = 60_000

/** A CBZ page position, kept in this browser (#1188). A full, disabled or cleared storage costs it, nothing else. */
const IMAGE_PAGE_KEY = (bookId: string) => `v2reader:cbz-position:${bookId}`
const localPage = {
  get(bookId: string): PagePosition | null {
    try {
      const p = JSON.parse(localStorage.getItem(IMAGE_PAGE_KEY(bookId)) ?? 'null')
      return isImagePage(p) ? p : null
    } catch { return null }
  },
  set(bookId: string, p: PagePosition) {
    try { localStorage.setItem(IMAGE_PAGE_KEY(bookId), JSON.stringify(p)) } catch (e) { console.warn('[v2 sync] cbz position not kept:', e) }
  },
}

interface Held extends HeldHighlight { revision: number | null }

export interface V2ReaderSync {
  readonly sha256: string
  /** The page's entry for `restore` (JSON): the position only; null when closed meanwhile. */
  restore(): Promise<string | null>
  /** This file's live highlights once the annotations pull lands (for the page's `addHighlights`); [] on failure. */
  restoreHighlights(): Promise<PageHighlight[]>
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
/** This write as sent is refused for good: dropped until the page changes it. */
const refused = (e: unknown) => {
  const code = v2Api.v2ErrorOf(e)?.code
  return code === 'invalid_payload' || code === 'chapter_not_found' || (e instanceof ApiError && (e.status === 400 || e.status === 422))
}

export function createV2ReaderSync(t: V2SyncTarget, o: {
  onStatus(s: V2SaveStatus): void
  /** The server's place adopted (ADR-019: nothing restored from the server yet): the host moves the page there. */
  onPosition?(p: PagePosition): void
  /** Waited for before the first read: the previous session of this tab still writing (a reopen). */
  after?: Promise<unknown>
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
  /** The server's reading state has been read: positions may be written. */
  let stateLoaded = false
  /** The book's file changed on the server: nothing more is written this open. */
  let gone = false
  /** What the server is known to hold: the position on this file and its revision (null: a first write). */
  let position: PagePosition | null = null
  let revision: number | null = null
  const held = new Map<string, Held>()
  /** The page's form of a highlight the server's won over (lost twice, deleted): not written again until the page changes it. */
  const overridden = new Map<string, PageHighlight>()
  let latest: PageEntry | null = null
  let running: Promise<void> | null = null
  let again = false
  let highlightsPull: Promise<PageHighlight[]> = Promise.resolve([])

  const status = (s: V2SaveStatus) => { if (current()) o.onStatus(s) }
  const keep = (a: V2Annotation, highlight = annotationHighlight(a)) =>
    held.set(a.id, { id: a.id, highlight, fileId: a.fileId, deleted: !!a.deletedAt, revision: a.revision })

  /** The server's state as known; `restored`: the page was restored from it (else it was not, ADR-019 adopt applies). */
  function knowState(s: V2ReadingState | null, restored: boolean) {
    stateLoaded = true
    const theirs = s && s.fileId === t.fileId ? statePosition(s, t.format) : null
    revision = s && s.fileId === t.fileId ? s.revision : null
    position = theirs
    if (restored || !theirs || !s || !latest?.position) return
    // Read late (the open's read failed): the page was never restored to the server's place. ADR-019 rule 5:
    // nothing restored yet → adopt when theirs is provably newer, else ours is written on their revision.
    const action = decideServerState({ local: latest.position, localFileId: t.fileId, server: s, reader: { restoreApplied: false, moved: true, index: null }, format: t.format })
    if (action === 'adopt' && current()) {
      latest = { ...latest, position: theirs }
      o.onPosition?.(theirs)
    }
  }

  async function readState(restored: boolean): Promise<boolean> {
    try {
      const s = await api.getReadingState(t.bookId)
      if (!live()) return false
      knowState(s, restored)
      return true
    } catch (e) {
      console.warn('[v2 sync] reading state not read:', errorCode(e))
      return false
    }
  }

  /** The position written; false when it did not land (it stays a difference). One retry after a lost revision. */
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
      // ADR-019 rule 5 on a lost write: a position is written only after the reader moved, where the rule asks the
      // reader. Owner decision 2026-11-11: on web THIS TAB WINS for now (no ask UI; #1232): ours is written
      // again on their revision. `reset`: the frontier is gone, our position stays (PDD). Lost twice: the next
      // `store` or flush writes on the revision last seen.
      if (err?.code === 'stale_revision' || err?.code === 'reset') {
        revision = cur?.revision ?? null
        if (!retried) return pushPosition(p, revision, true)
      } else if (err && BOOK_GONE.has(err.code)) {
        gone = true
      } else if (refused(e)) {
        // Refused as sent: held as if written, so it is not sent again until the reader moves.
        console.warn('[v2 sync] position refused:', errorCode(e))
        position = p
        return true
      }
      console.warn('[v2 sync] position not saved:', errorCode(e))
      return false
    }
  }

  /**
   * A highlight written; false when it did not land. PDD "Annotations": own write, re-apply once, a tombstone wins.
   * `pageId`: the id the page holds it under (another after an `id_conflict` re-key).
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
      /** Not written again until the page changes it: the page's own form, under the page's id. */
      const settled = () => { overridden.set(pageId, { ...h, id: pageId }); return true }
      if (err?.code === 'stale_revision' && cur && !retried && !ownAnnotationWrite(cur, write)) return pushHighlight(h, cur.revision, true, pageId)
      if ((err?.code === 'stale_revision' || err?.code === 'deleted') && cur) {
        if (ownAnnotationWrite(cur, write)) {
          keep(cur, h)
          return true
        }
        // Lost twice, or deleted elsewhere: the server's row is kept, and the page's form (still on screen until the
        // next open) is not written over it again until the reader changes it.
        keep(cur)
        return settled()
      }
      // The id is someone else's (PDD `id_conflict`): a new one, once. The page keeps the old id; the same CFI +
      // text under the new one is its twin (entryChanges), so it is not sent again.
      if (err?.code === 'id_conflict' && !retried) return pushHighlight({ ...h, id: newId() }, null, true, pageId)
      if (err && BOOK_GONE.has(err.code)) gone = true
      else if (refused(e) || err?.code === 'id_conflict') {
        console.warn('[v2 sync] highlight refused:', errorCode(e))
        return settled()
      }
      console.warn('[v2 sync] highlight not saved:', errorCode(e))
      return false
    }
  }

  /** The changes the latest entry makes, highlights the server won over left out. */
  function changesOf(entry: PageEntry) {
    const highlights = entry.highlights.filter((h) => {
      const ours = overridden.get(h.id)
      return !ours || !sameJson(ours, normalisedHighlight(h))
    })
    return entryChanges(t.fileId, { position, highlights: [...held.values()] }, { position: entry.position, highlights }, newId)
  }

  async function pass() {
    if (gone || !latest) return
    if (!stateLoaded) await readState(false)
    const changes = changesOf(latest)
    let saved = true
    if (changes.position) {
      if (isImagePage(changes.position)) {
        localPage.set(t.bookId, changes.position)
        position = changes.position
      } else if (!stateLoaded || !(await pushPosition(changes.position, revision))) saved = false
    }
    for (const { highlight } of changes.highlights) {
      if (!live() || gone) break
      if (!(await pushHighlight(highlight, held.get(highlight.id)?.revision ?? null))) saved = false
    }
    status(gone ? 'reopen' : saved ? 'saved' : 'unsaved')
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

  return {
    sha256: t.sha256,
    async restore() {
      await o.after?.catch(() => {})
      if (!current()) return null
      highlightsPull = api.annotations().then((annotations) => {
        if (!live()) return []
        // Every one of the book's rows is held (their revisions); only this file version's live ones are drawn.
        const drawn: PageHighlight[] = []
        for (const a of annotations) {
          if (a.bookId !== t.bookId) continue
          keep(a)
          const h = held.get(a.id)!.highlight
          if (h && !a.deletedAt && a.fileId === t.fileId) drawn.push(h)
        }
        return drawn
      }, (e) => {
        console.warn('[v2 sync] highlights not loaded:', errorCode(e))
        return []
      })
      if (!(await readState(true))) status('unsaved')
      if (!current()) return null
      // A CBZ page lives in this browser only (#1188).
      if (t.format === 'cbz') position = localPage.get(t.bookId)
      return JSON.stringify(pageEntry({ sha256: t.sha256, size: t.size, name: t.name }, position, []))
    },
    async restoreHighlights() {
      const list = await highlightsPull
      return current() ? list : []
    },
    store(json) {
      if (!current()) return
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
      const bodies: [send: (body: string) => void, body: string][] = []
      const p = latest.position
      if (stateLoaded && p && !sameJson(position, p)) {
        const write = positionWrite(p, t.fileId, revision, Date.now(), t.format)
        if (write) bodies.push([(b) => api.keepalivePutState(t.bookId, b), JSON.stringify(write)])
      }
      for (const { highlight: h } of changes.highlights) {
        const write = highlightWrite(h, t.bookId, t.fileId, held.get(h.id)?.revision ?? null)
        if (write) bodies.push([(b) => api.keepalivePutAnnotation(h.id, b), JSON.stringify(write)])
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
      closing ??= (running ?? (latest && !gone ? kick() : Promise.resolve())).catch(() => {}).finally(() => { closed = true })
      return closing
    },
  }
}
