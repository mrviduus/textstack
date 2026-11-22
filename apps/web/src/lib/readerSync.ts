/**
 * The web V2 reader's reader data on the server (#1226; docs/internal/v2/v2-reader-web-hosting.md S5): one
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
 * - Another device's place on a lost write (#1232): ours is written again on their revision, and when theirs is
 *   provably newer than this tab's last saved (or restored) place (ADR-019, `decideServerState`) it is offered
 *   (`onNewerPlace`). The reader is never moved by the session: a position write exists only because they moved.
 * - **Finish book** (#1266, `complete`): the state the server holds, written again with `completedAt` on its
 *   revision, which the session then holds (a write from outside the session would make its next position
 *   write lose and offer the reader their own place as another device's). A state read there on a revision this
 *   session has not seen goes through the same check as a lost write's (own write, or another device's place
 *   offered). Lost to one of the session's own position writes: written once more after it. A close waits for it
 *   (the host unmounted right after the click). Online-only: a failure is the host's error with a retry.
 * - Every server state the session takes (the restore's read, a write's answer, a conflict's `current`, the
 *   completion's) tells the host the book's completion (`onCompleted`): a reset elsewhere brings the button back.
 * - **Notes and removals** (#1312). A note is the host's (the page holds none): `setNote` keeps it as this tab's edit
 *   until a write carrying it lands, and every highlight write carries the note (the PUT replaces the row). A note
 *   is diffed with the page's form (`entryChanges` on the form plus `noteText`), so a refused note is not resent
 *   until it changes. On `stale_revision` the retry keeps the server's note unless this tab edited it (its colour is
 *   the page's, re-applied once, as before). `remove` (the page's `highlight-removed`) is a `DELETE`, before any
 *   write of that highlight; a 404 (never on the server) is done; a failure stays queued and unsaved. The tombstone
 *   then wins: the page's form is never written again.
 *
 * Answers land while the session is live; the host is told nothing once it is closing (another open, the host
 * unmounted), and nothing lands once the account store reset (`resetSince`, the shared epoch guard).
 */
import {
  annotationHighlight, annotationQuotation, ApiError, entryChanges, entryFor, highlightWrite, normalisedHighlight, ownAnnotationWrite,
  decideServerState, ownStateWrite, pageEntry, pageNameRefusal, positionWrite, sameJson, statePosition, syncApi,
  type HeldHighlight, type PageEntry, type PageHighlight, type PagePosition, type PageQuotation, type Annotation, type AnnotationWrite, type ReadingState,
  type ReadingStateWrite,
} from '@textstack/shared'
import { resetSince } from '../api/sync'
import { keepaliveWrite } from './progressSync'

/** The open book on the server: its current file, as the page's entry names it. */
export interface SyncTarget {
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
export type SaveStatus = 'saved' | 'unsaved' | 'reopen' | 'noHighlights'

/** The server calls a session makes (the shared client's; a fake in tests). */
export interface ReaderSyncApi {
  getReadingState(bookId: string): Promise<ReadingState | null>
  /** The user's annotations (the feed is per user: filtered by book here). */
  annotations(): Promise<Annotation[]>
  putReadingState(bookId: string, body: ReadingStateWrite): Promise<ReadingState>
  putAnnotation(id: string, body: AnnotationWrite): Promise<Annotation>
  /** The tombstone (200, idempotent); 404 when the server never had it. */
  deleteAnnotation(id: string): Promise<Annotation>
  /** Writes that outlive the page (`pagehide`); their answers are not read. */
  keepalivePutState(bookId: string, body: string): void
  keepalivePutAnnotation(id: string, body: string): void
  keepaliveDeleteAnnotation(id: string): void
}

export const readerSyncApi: ReaderSyncApi = {
  getReadingState: (id) => syncApi.getReadingState(id),
  // A fresh pull, never one in flight (pullFeed's): a reopen must see the previous session's writes.
  // ponytail: the whole annotations feed per open, as highlightSync; a per-book list when the API has one.
  annotations: async () => (await syncApi.pullAll<Annotation>('annotations')).items,
  putReadingState: syncApi.putReadingState,
  putAnnotation: syncApi.putAnnotation,
  deleteAnnotation: syncApi.deleteAnnotation,
  keepalivePutState: (id, body) => void keepaliveWrite(syncApi.readingStateUrl(id), body).catch(() => {}),
  keepalivePutAnnotation: (id, body) => void keepaliveWrite(syncApi.annotationUrl(id), body).catch(() => {}),
  keepaliveDeleteAnnotation: (id) => void keepaliveWrite(syncApi.annotationUrl(id), null, 'DELETE').catch(() => {}),
}

/** The browser's keepalive budget is 64 KiB for every request in flight; headroom kept. */
export const KEEPALIVE_BUDGET = 60_000

/** `complete` before the server holds any place of this file version: the host says what to do. */
export const NO_PLACE_YET = 'no reading state on this file yet'

/** The last session of each book still writing: the next one of that book reads after it, whatever was open between. */
const closingByBook = new Map<string, Promise<void>>()

interface Held extends HeldHighlight { revision: number | null; note: string | null }
/** A highlight as this session diffs and writes it: the page's form plus the host's note. */
type Noted = PageHighlight & { noteText: string | null }
/** The page's form of a noted highlight (what the page holds and `held` keeps). */
const pageFormOf = ({ noteText: _, ...h }: Noted): PageHighlight => h

export interface ReaderSync {
  readonly target: SyncTarget
  /** The page's entry for `restore` (JSON, the position only); null when closed meanwhile. Throws when the state cannot be read. */
  restore(): Promise<string | null>
  /** The annotations pull: `onHighlights` when it lands, `noHighlights` when it fails (retried by store/flush). */
  loadHighlights(): Promise<void>
  /** The page's `store` payload: written to the server (one pass at a time, the latest entry wins). */
  store(json: string): void
  /** Writes what is still unsaved now (the tab hidden). */
  flush(): Promise<void>
  /**
   * The tab is going away: what is unsaved, by keepalive writes (the position first, within the budget). `last`
   * (#1286): the page's latest `store` payload, taken by the host synchronously where its posted one comes too late;
   * checked as a `store` is, and written by the keepalive only.
   */
  flushKeepalive(last?: string): void
  /**
   * Finish book (#1266): resolves to the book's `completedAt` once the server holds it (its own, when the book
   * was already finished: set once). Rejects when it did not land; calling again is the retry.
   */
  complete(): Promise<string>
  /** #1312: the note of highlight `id` as this tab holds it (its own edit, else the server's), null for none. */
  note(id: string): string | null
  /** #1312: the reader's note (null: none) for highlight `id`, written with it. Ignored for one removed. */
  setNote(id: string, note: string | null): void
  /** #1312: the page removed highlight `id` (`highlight-removed`): tombstoned on the server. */
  remove(id: string): void
  /** #1312 review: the id the server holds a page id under (after an `id_conflict` re-key, the new one). */
  real(id: string): string
  /** #1312 review: the server's row for this page id is a tombstone (deleted elsewhere): not editable. */
  deleted(id: string): boolean
  /** Another open, or the host unmounted: one last pass of what is unsaved (`last` too, as above), then nothing more is written. */
  close(last?: string): Promise<void>
}

/** A position write exists only because the reader moved (or took an offer): ADR-019 then keeps or asks. */
const MOVED = { restoreApplied: true, moved: true, index: null }
const errorCode = (e: unknown) => syncApi.syncErrorOf(e)?.code ?? (e as Error | null)?.message
/** The book's file is not what this session reads any more: no write of this open can land. */
const BOOK_GONE = new Set(['file_replaced', 'unknown_file', 'book_not_found'])
/** This write as sent is refused for good: not resent until the page changes it. */
const refusedAsSent = (e: unknown) => {
  const code = syncApi.syncErrorOf(e)?.code
  return code === 'invalid_payload' || code === 'chapter_not_found' || (e instanceof ApiError && (e.status === 400 || e.status === 422))
}
/** `h` as the page's form held in `m` (compared as normalised). */
const isHeldAs = (m: Map<string, PageHighlight>, h: PageHighlight) => {
  const x = m.get(h.id)
  return !!x && sameJson(x, normalisedHighlight(h))
}

export function createReaderSync(t: SyncTarget, o: {
  onStatus(s: SaveStatus): void
  /** This file's live highlights, once the pull lands: the host draws them and offers highlighting; the book's quotations (#1195) are listed. */
  onHighlights(list: (PageHighlight | PageQuotation)[]): void
  /** Another device's place, provably newer than this tab's last save: offered (ours is written anyway). */
  onNewerPlace(p: PagePosition): void
  /** The book's completion as the server holds it, from every state the session takes (null: not finished): the host's Finish book block (#1266). */
  onCompleted?(completedAt: string | null): void
  /** Waited for before the first read; by default the last session of this book still writing (a reopen). */
  after?: Promise<unknown>
  /** False where the page offers no highlights (a PDF, a CBZ): no annotations pull. */
  highlights?: boolean
  api?: ReaderSyncApi
  newId?: () => string
}): ReaderSync {
  const api = o.api ?? readerSyncApi
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
  /** The last position write sent: a later `stale_revision` whose state is this one is ours (its answer was lost). */
  let lastSent: { p: PagePosition; write: ReadingStateWrite } | null = null
  /**
   * The last keepalive position write (#1286), its answer never read: ours too if the tab is kept (bfcache). Its own
   * variable: a pass's write still in flight (`lastSent`) may be the one that lands.
   */
  let keptAlive: { p: PagePosition; write: ReadingStateWrite } | null = null
  let latest: PageEntry | null = null
  /** The payload `latest` came from: the same one again (the page's posted `store` after the host took it) is not a change. */
  let latestJson: string | null = null
  let running: Promise<void> | null = null
  let again = false
  /** The completion being written (`complete`): a close waits for it. */
  let completing: Promise<string> | null = null

  const status = (s: SaveStatus) => { if (current()) o.onStatus(s) }
  /** A state of this file the server holds: the host is told its completion. Another file's (a `file_replaced`
   * 409 carries the new file's state) is not this book's. */
  const completion = (s: ReadingState) => { if (current() && s.fileId === t.fileId) o.onCompleted?.(s.completedAt ?? null) }
  /**
   * A server state this session did not see written (ADR-019, a reader who moved: only `keep` or `prompt`)
   * against this tab's last saved place: `own`'s state (a write whose answer was lost) is ours; theirs provably
   * newer is offered. The move being written is never the comparison (always the newest).
   */
  const theirs = (cur: ReadingState, own: typeof lastSent) => {
    const mine = [own, keptAlive].find((x) => x && ownStateWrite(cur, x.write))
    if (mine) position = mine.p
    else if (current() && decideServerState({ local: position, localFileId: t.fileId, server: cur, reader: MOVED, format: t.format }) === 'prompt') {
      // `prompt`: their state is a position on this file (decideServerState).
      o.onNewerPlace(statePosition(cur, t.format)!)
    }
  }
  const keep = (a: Annotation, highlight = annotationHighlight(a)) =>
    held.set(a.id, { id: a.id, highlight, fileId: a.fileId, deleted: !!a.deletedAt, revision: a.revision, note: a.noteText ?? null })
  /** This tab's note edits not yet on the server (id → note, null: cleared), and its removals not yet tombstoned. */
  const notes = new Map<string, string | null>()
  const removals = new Set<string>()
  /**
   * Re-keys of this session (`id_conflict`), old → new, in memory only. Every way in resolves through it: the page's forms
   * (its stores carry the old id until it renames the highlight, and the last one may come with the close) and the
   * host's `setNote` / `remove` / `note` for it (#1312 review).
   */
  const rekeyed = new Map<string, string>()
  const real = (id: string) => rekeyed.get(id) ?? id
  const noteFor = (pageId: string) => {
    const id = real(pageId)
    return notes.has(id) ? notes.get(id)! : held.get(id)?.note ?? null
  }
  const noted = (h: PageHighlight, note = noteFor(h.id)): Noted => ({ ...h, noteText: note })

  /** The position written; false when it did not land or was refused. One retry after a lost revision. */
  async function pushPosition(p: PagePosition, expected: number | null, retried = false): Promise<boolean> {
    // A fraction-only position has no write the server takes; a CBZ or pre-paginated EPUB page is `page-name` (#1188, #1196).
    const write = positionWrite(p, t.fileId, expected, Date.now(), t.format)
    if (!write) {
      const why = pageNameRefusal(p, t.format)
      if (why) console.warn(`[v2 sync] page position not synced (${t.format}): ${why}`)
      return false
    }
    const prev = lastSent
    lastSent = { p, write }
    try {
      const s = await api.putReadingState(t.bookId, write)
      if (live()) { position = p; revision = s.revision }
      completion(s)
      return true
    } catch (e) {
      if (!live()) return true
      const err = syncApi.syncErrorOf(e)
      const cur = (err?.current ?? null) as ReadingState | null
      if (cur) completion(cur)
      if (err?.code === 'stale_revision' && cur && ownStateWrite(cur, write)) {
        position = p
        revision = cur.revision
        return true
      }
      // Lost write (#1232): ours again on their revision (`reset` too: the frontier is gone, our position stays, PDD).
      // Their state checked against this tab's last saved place (`theirs`); the state of our previous write whose
      // answer was lost is ours: no offer. Lost twice: the next `store` or flush writes on the revision last seen.
      if (err?.code === 'stale_revision' || err?.code === 'reset') {
        revision = cur?.revision ?? null
        if (cur) theirs(cur, prev)
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
  async function pushHighlight(h: Noted, expected: number | null, retried = false, pageId = h.id): Promise<boolean> {
    const write = highlightWrite(h, t.bookId, t.fileId, expected, h.noteText)
    if (!write) return false
    /** The note sent is what this tab holds now: its edit is done (a newer edit meanwhile stays). */
    const landed = (a: Annotation) => {
      keep(a, pageFormOf(h))
      if (h.id !== pageId) {
        // A re-key (`id_conflict`) landed: the page keeps the old id until the next open (its restore carries the new
        // one); every way in resolves through `rekeyed` from now on, and this tab's edits made under the old id while it
        // was in flight move to the new one.
        if (notes.has(pageId)) notes.set(h.id, notes.get(pageId)!)
        notes.delete(pageId)
        if (removals.delete(pageId)) removals.add(h.id)
        rekeyed.set(pageId, h.id)
      }
      if (notes.has(h.id) && notes.get(h.id) === (a.noteText ?? null)) notes.delete(h.id)
    }
    try {
      const a = await api.putAnnotation(h.id, write)
      if (live()) landed(a)
      return true
    } catch (e) {
      if (!live()) return true
      const err = syncApi.syncErrorOf(e)
      const cur = (err?.current ?? null) as Annotation | null
      const sentForm = { ...h, id: pageId }
      // Re-applied once on their revision: the page's form, and the note only if this tab edited it.
      if (err?.code === 'stale_revision' && cur && !retried && !ownAnnotationWrite(cur, write)) {
        return pushHighlight({ ...h, noteText: notes.has(pageId) ? notes.get(pageId)! : cur.noteText ?? null }, cur.revision, true, pageId)
      }
      if ((err?.code === 'stale_revision' || err?.code === 'deleted') && cur) {
        if (ownAnnotationWrite(cur, write)) {
          landed(cur)
          return true
        }
        // Lost twice, or deleted elsewhere: the server's row (its note too) is kept, and the page's form (still on
        // screen until the next open) is not written over it again until the reader changes it.
        keep(cur)
        notes.delete(pageId)
        overridden.set(pageId, noted(pageFormOf(sentForm), cur.noteText ?? null))
        return true
      }
      // The id is someone else's (PDD `id_conflict`): a new one, once. The page keeps the old id; the same CFI +
      // text under the new one is its twin (entryChanges), so it is not sent again.
      if (err?.code === 'id_conflict' && !retried) return pushHighlight({ ...h, id: newId() }, null, true, pageId)
      if (err && BOOK_GONE.has(err.code)) gone = true
      else if (refusedAsSent(e) || err?.code === 'id_conflict') refused.set(pageId, sentForm)
      console.warn('[v2 sync] highlight not saved:', errorCode(e))
      return false
    }
  }

  /** A removal tombstoned; false when it did not land (kept for the next pass). A 404: the server never had it. */
  async function pushRemoval(id: string): Promise<boolean> {
    try {
      const a = await api.deleteAnnotation(id)
      if (live()) {
        keep(a)
        removals.delete(id)
      }
      return true
    } catch (e) {
      if (!live()) return true
      if (e instanceof ApiError && e.status === 404) {
        // Held as deleted: a form of it still in a `store` (one sent before the removal) is never written.
        held.set(id, { id, highlight: null, fileId: t.fileId, deleted: true, revision: null, note: null })
        removals.delete(id)
        return true
      }
      console.warn('[v2 sync] highlight not deleted:', errorCode(e))
      return false
    }
  }

  /**
   * The highlights to diff: the page's forms in `entry` (none being removed) with their notes, plus a highlight with
   * a note edit that `entry` lacks (drawn by `addHighlights`, which the page does not save), in its held form.
   */
  function notedForms(entry: PageEntry | null): Noted[] {
    // Under the id the server holds them by (an alias after a re-key): diffed against that row.
    const forms = (entry?.highlights ?? []).map((h) => (rekeyed.has(h.id) ? { ...h, id: real(h.id) } : h)).filter((h) => !removals.has(h.id)).map((h) => noted(h))
    const ids = new Set(forms.map((h) => h.id))
    for (const id of notes.keys()) {
      const r = held.get(id)
      if (!ids.has(id) && !removals.has(id) && r?.highlight && !r.deleted && r.fileId === t.fileId) forms.push(noted(r.highlight))
    }
    return forms
  }

  /** The changes the latest entry and the notes make, forms held as this tab has them (overridden, refused) left out. */
  function changesOf(entry: PageEntry | null) {
    const highlights = notedForms(entry).filter((h) => !isHeldAs(overridden, h) && !isHeldAs(refused, h))
    // A row whose removal is still to be sent is no live row (#1314 review): one made again at its place (the same CFI
    // and words, a new id) is not its twin, and is written.
    const heldNoted = [...held.values()].map((r) => ({ ...r, deleted: r.deleted || removals.has(r.id), highlight: r.highlight && noted(r.highlight, r.note) }))
    const changes = entryChanges<Noted>(t.fileId, { position, highlights: heldNoted }, { position: entry?.position ?? null, highlights }, newId)
    // A page id skipped as a held row's twin is that row from now on (#1314 review), as a re-key is.
    for (const { from, to } of changes.aliases) if (!rekeyed.has(from)) rekeyed.set(from, to)
    return changes
  }

  async function pass() {
    if (gone) return
    // Not waited for: the position is written now, the highlights by one more pass when the pull lands.
    if (!highlightsLoaded) void loadHighlights().then(() => { if (highlightsLoaded && (latest || notes.size) && current()) void kick() })
    if (!latest && !notes.size && !removals.size) return
    let saved = true
    // Removals first: a tombstone wins over every write of that highlight after it.
    for (const id of [...removals]) {
      if (!live() || gone) break
      if (!(await pushRemoval(id))) saved = false
    }
    const changes = changesOf(latest)
    if (changes.position && !(await pushPosition(changes.position, revision))) saved = false
    // Highlight writes wait for the pull: without the server's rows a write would duplicate or overwrite one.
    if (highlightsLoaded) {
      for (const { highlight } of changes.highlights) {
        if (!live() || gone) break
        // Read again: a removal may have been asked for since the diff.
        if (removals.has(highlight.id) || held.get(highlight.id)?.deleted) continue
        if (!(await pushHighlight(highlight, held.get(highlight.id)?.revision ?? null))) saved = false
      }
    }
    // A refused value this tab still holds stays unsaved, though it is not resent.
    const stuck = (!!refusedPosition && !!latest && sameJson(refusedPosition, latest.position)) || notedForms(latest).some((h) => isHeldAs(refused, h))
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

  /**
   * Finish book: the place on screen written first, then the state as the server holds it plus `completedAt`.
   * Lost on `stale_revision` (a debounced `store` of this session, or another device's write, landed meanwhile):
   * after the running pass, once more; a second loss is the host's error, with its Retry.
   */
  async function completeOnce(retried = false): Promise<string> {
    await (running ?? (latest ? kick() : undefined))
    if (gone) throw new Error('the book changed on the server')
    const s = await api.getReadingState(t.bookId)
    if (!live()) throw new Error('the book is not open')
    // ponytail: a book finished without ever moving in it (one screen long) has no state to complete; the
    // first-locator write `completeBook` makes for the shelf can be added here if that is ever met.
    if (s?.fileId !== t.fileId) throw new Error(NO_PLACE_YET)
    // Written since this session last saw it (another device): checked as a lost write's state, then adopted.
    // An older one (a write of this session landed after the read) is never a revision back.
    if (s.revision > (revision ?? 0)) {
      theirs(s, lastSent)
      revision = s.revision
    }
    if (s.completedAt) {
      completion(s)
      return s.completedAt
    }
    // As it stands (owner 2026-11-13: the real fraction; the same locator and instant, so no device takes
    // this for a newer place), plus the completion.
    let done: ReadingState
    try {
      done = await api.putReadingState(t.bookId, {
        expectedRevision: s.revision, fileId: s.fileId, currentLocator: s.currentLocator, bookFraction: s.bookFraction,
        completedAt: new Date().toISOString(), clientRecordedAt: s.clientRecordedAt,
      })
    } catch (e) {
      if (!retried && live() && syncApi.syncErrorOf(e)?.code === 'stale_revision') return completeOnce(true)
      throw e
    }
    if (!done.completedAt) throw new Error('the server did not keep the completion')
    if (live() && (revision ?? 0) < done.revision) revision = done.revision
    completion(done)
    return done.completedAt
  }

  function loadHighlights(): Promise<void> {
    if (highlightsLoaded || !current()) return Promise.resolve()
    return (pulling ??= (async () => {
      try {
        const annotations = await api.annotations()
        if (!live()) return
        // Every one of the book's rows is held (their revisions); only this file version's live ones are drawn.
        const drawn: (PageHighlight | PageQuotation)[] = []
        for (const a of annotations) {
          if (a.bookId !== t.bookId) continue
          keep(a)
          const h = held.get(a.id)!.highlight
          if (h && !a.deletedAt && a.fileId === t.fileId) drawn.push(h)
          // #1195: a legacy anchor annotation is listed as a quotation; held with no page form, so never written back.
          const q = a.fileId === t.fileId && annotationQuotation(a)
          if (q) drawn.push(q)
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

  /** The page's payload as `latest`; false when not taken (closing, not restored, not this book's, the same one again). */
  function take(json: string): boolean {
    if (!current() || !ready || json === latestJson) return false
    const entry = entryFor(json, t)
    if (!entry) {
      console.warn('[v2 sync] store: not an entry for this book')
      return false
    }
    latest = entry
    latestJson = json
    return true
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
      position = onFile && statePosition(onFile, t.format)
      ready = true
      o.onCompleted?.(onFile?.completedAt ?? null)
      return JSON.stringify(pageEntry({ sha256: t.sha256, size: t.size, name: t.name }, position, []))
    },
    loadHighlights,
    store(json) {
      if (take(json)) void kick()
    },
    // A pass running already writes the latest entry: joined, not asked for again.
    flush: () => (!current() ? Promise.resolve() : running ?? kick()),
    flushKeepalive(last) {
      // Taken without a pass: its PUT and the keepalive one would be the same write twice.
      if (last !== undefined) take(last)
      if (!live() || gone || (!latest && !notes.size && !removals.size)) return
      const changes = changesOf(latest)
      const bodies: [send: (body: string) => void, body: string][] = []
      // ponytail: a position PUT still in flight on the same revision makes this one lose (stale_revision, never
      // read): on a slow link the last page turn before closing the tab can be lost; the next open is one turn back.
      const p = changes.position
      const write = p && positionWrite(p, t.fileId, revision, Date.now(), t.format)
      // Sent, it is ours (`keptAlive`, its answer never read): if the tab is kept (bfcache), a later write that loses to
      // it knows the server's state as ours, not another device's newer place (`theirs`).
      if (p && write) bodies.push([(b) => { keptAlive = { p, write }; api.keepalivePutState(t.bookId, b) }, JSON.stringify(write)])
      // Removals before any highlight write (each counted as a small request: no body).
      for (const id of removals) bodies.push([() => api.keepaliveDeleteAnnotation(id), ' '.repeat(100)])
      if (highlightsLoaded) {
        for (const { highlight: h } of changes.highlights) {
          const w = highlightWrite(h, t.bookId, t.fileId, held.get(h.id)?.revision ?? null, h.noteText)
          if (w) bodies.push([(b) => api.keepalivePutAnnotation(h.id, b), JSON.stringify(w)])
        }
      }
      // The position first, then highlights, while the budget lasts.
      let left = KEEPALIVE_BUDGET
      for (const [send, body] of bodies) {
        const size = new TextEncoder().encode(body).length
        // One body over what is left (a long note) is skipped, not the end: the writes after it still go.
        if (size > left) continue
        left -= size
        send(body)
      }
    },
    complete() {
      if (!current() || !ready) return Promise.reject(new Error('the book is not open'))
      return (completing ??= completeOnce().finally(() => { completing = null }))
    },
    note: noteFor,
    setNote(pageId, note) {
      const id = real(pageId)
      if (!current() || removals.has(id) || held.get(id)?.deleted || noteFor(id) === note) return
      notes.set(id, note)
      void kick()
    },
    real,
    deleted: (pageId) => !!held.get(real(pageId))?.deleted,
    remove(pageId) {
      const id = real(pageId)
      // A tombstone already (deleted elsewhere, or by this tab): nothing to send.
      if (!current() || removals.has(id) || held.get(id)?.deleted) return
      removals.add(id)
      notes.delete(id)
      void kick()
    },
    close(last) {
      if (closing) return closing
      // A newer entry taken joins the running pass as one more (kick), else as before.
      const taken = last !== undefined && take(last)
      // A completion in flight (the host unmounted right after the click) is waited for: it still lands.
      const done = closing = Promise.all([
        (taken ? kick() : running ?? ((latest || notes.size || removals.size) && !gone ? kick() : Promise.resolve())).catch(() => {}),
        completing?.catch(() => {}),
      ]).then(() => {}).finally(() => {
        closed = true
        if (closingByBook.get(t.bookId) === done) closingByBook.delete(t.bookId)
      })
      closingByBook.set(t.bookId, done)
      return done
    },
  }
}
