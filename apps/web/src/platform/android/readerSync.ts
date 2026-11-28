/**
 * The Android reader's saving (ADR-035, #1642): the web `ReaderSync` contract (`lib/readerSync.ts`, what ReaderHost
 * calls) over the device library, as the Expo reader saves (`ReaderScreen.tsx` over `readerStorage()`). Local first:
 * - Every member reads and writes the device library only (`hostStorage`). No network, no account: reading,
 *   highlighting and the place all work offline. A sync pass (`syncSoon`, 10 s after the last save, as in Expo)
 *   pushes the outbox and resolves the conflicts later (ADR-019).
 * - `restore` gives the stored place only; `loadHighlights` the stored highlights (`onHighlights`), as the web host
 *   expects. The notes are the device's (`notes()`), kept in memory for the host's synchronous `note` / `deleted`.
 * - The page's `store`s are written one at a time, the latest wins. A failed write is `unsaved` and written again on
 *   the next `store` or flush.
 * - While open, the book is the mounted reader of every pass (`holdReaderHost`). It reports a reader who moved
 *   (web's `MOVED`), so a pulled place is never applied over the page: it is kept or offered (`onNewerPlace`).
 *   The session never moves the reader (the web contract; the Expo reader moves a reader who did not move).
 * - Finish book: `finishBook` (set once). Rejected with `NO_PLACE_YET` while this file has no stored place, as web
 *   rejects while the server has none.
 */
import { entryFor, pageEntry, type PagePosition } from '@textstack/shared'
import { NO_PLACE_YET, type createReaderSync, type ReaderSync, type SaveStatus, type SyncTarget } from '../../lib/readerSync'
import { readerStorage } from './deviceDownload'
import type { HostStorage } from './hostStorage'
import { syncSoon } from './library'
import { holdReaderHost, openBookHost } from './librarySync'
import type { BookNotes } from './localLibrary'
import { resetSince } from './syncClient'

/** A sync pass is asked for this long after the last save (the Expo reader's `SYNC_AFTER_SAVE_MS`). */
export const SYNC_AFTER_SAVE_MS = 10_000

let syncTimer: ReturnType<typeof setTimeout> | undefined
/**
 * One pass, 10 s after the last call. ponytail: not cleared when the reader closes (Expo clears it on unmount), so the
 * last saves of an open still go with a pass soon after.
 */
export function syncAfterSave() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => syncSoon(), SYNC_AFTER_SAVE_MS)
}

/** The open reader as a pass sees it: moved (web's `MOVED`), so ADR-019 only keeps or asks. */
const MOVED = { restoreApplied: true, moved: true, index: null }

/** The last session of each book still writing: the next one of that book reads after it (web `closingByBook`). */
const closingByBook = new Map<string, Promise<void>>()

type Options = Parameters<typeof createReaderSync>[1]

/** `deps`: the storage and the pass trigger (fakes in tests). */
export function createDeviceReaderSync(t: SyncTarget, o: Options, deps: { storage?: HostStorage; sync?: () => void } = {}): ReaderSync {
  const storage = deps.storage ?? readerStorage()
  const sync = deps.sync ?? syncAfterSave
  const sha = t.sha256.toLowerCase()
  const reset = resetSince()
  let closed = false
  let closing: Promise<void> | null = null
  const live = () => !closed && !reset()
  const current = () => live() && !closing
  let ready = false
  let highlightsLoaded = o.highlights === false
  let pulling: Promise<void> | null = null
  /** The page's last payload taken, and the last one written. */
  let latest: string | null = null
  let saved: string | null = null
  let storeFailed = false
  /** A note or removal that did not land (Expo: an error, no retry): unsaved for the rest of this open. */
  let editFailed = false
  let completing: Promise<string> | null = null
  let notes: BookNotes = { known: new Map(), unknown: new Set(), deleted: new Set() }
  /** Edits made in memory: a notes read started before one is not taken. */
  let edits = 0

  /** Every device write of this session, in order (a note after the store that made its highlight). */
  let chain: Promise<unknown> = Promise.resolve()
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn)
    chain = p.catch(() => {})
    return p
  }

  const status = (s: SaveStatus) => { if (current()) o.onStatus(s) }
  const report = () => status(storeFailed || editFailed ? 'unsaved' : highlightsLoaded || o.bookmarksOnly ? 'saved' : 'noHighlights')
  const completion = async () => {
    const at = (await storage.books()).find((b) => b.local && b.sha256 === sha)?.completedAt ?? null
    if (current()) o.onCompleted?.(at)
    return at
  }
  const refreshNotes = () => {
    const at = edits
    run(() => storage.notes(sha)).then((m) => { if (live() && at === edits) notes = m }, (e: unknown) => console.warn('[v2] notes not read:', e))
  }

  // The open book for every pass while this session is open: the hold is released by `close`.
  const release = holdReaderHost({
    ...openBookHost(() => (current() ? sha : null), () => MOVED, (a) => { if (current()) o.onNewerPlace(a.position) }),
    // A pass may have pulled notes or a completion (a reset elsewhere brings the button back).
    passed: () => {
      if (!current()) return
      refreshNotes()
      completion().catch(() => {})
    },
  })

  /** The latest payload written; one queued write at a time, which takes the latest when it runs. */
  let queued: Promise<void> | null = null
  function save(): Promise<void> {
    if (!highlightsLoaded && current()) void loadHighlights()
    if (latest === null || latest === saved) return chain.then(() => {})
    return (queued ??= run(async () => {
      queued = null
      const json = latest!
      if (json === saved) return
      try {
        await storage.writeStore(sha, json)
        saved = json
        storeFailed = false
        sync()
      } catch (e) {
        console.warn('[v2] place not saved on the device:', e)
        storeFailed = true
      }
      report()
    }))
  }

  /** The page's payload as `latest`; false when not taken (closing, not restored, not this book's, the same one again). */
  function take(json: string): boolean {
    if (!current() || !ready || json === latest) return false
    if (!entryFor(json, { sha256: sha, size: t.size })) {
      console.warn('[v2] store: not an entry for this book')
      return false
    }
    latest = json
    return true
  }

  function loadHighlights(): Promise<void> {
    if (highlightsLoaded || !current()) return Promise.resolve()
    return (pulling ??= (async () => {
      try {
        const [json, m] = await Promise.all([run(() => storage.readStore(sha)), run(() => storage.notes(sha))])
        if (!live()) return
        const e = entryFor(json, { sha256: sha, size: t.size })
        if (edits === 0) notes = m
        highlightsLoaded = true
        if (current()) o.onHighlights([...(e?.highlights ?? []), ...(e?.quotations ?? [])])
      } catch (e) {
        console.warn('[v2] highlights not read:', e)
        if (!o.bookmarksOnly) status('noHighlights')
      } finally {
        pulling = null
      }
    })())
  }

  /** An edit's write; its answer reads the notes again and asks for a pass. */
  const edit = (what: string, fn: () => Promise<boolean>) => {
    edits++
    run(fn).then((done) => {
      if (!done) console.warn(`[v2] ${what}: the highlight is not held here`)
      refreshNotes()
      sync()
    }, (e: unknown) => {
      console.warn(`[v2] ${what} not saved:`, e)
      editFailed = true
      refreshNotes()
      report()
    })
  }

  const real = (id: string) => storage.realId(id)
  const isDeleted = (id: string) => notes.deleted.has(id) || notes.deleted.has(real(id))
  const noteOf = (id: string) => notes.known.get(id) ?? notes.known.get(real(id)) ?? null

  return {
    target: t,
    async restore() {
      await (o.after ?? closingByBook.get(t.bookId))?.catch(() => {})
      if (!current()) return null
      // Throws when the entry cannot be read: the host offers a retry.
      const json = await run(() => storage.readStore(sha))
      if (!current()) return null
      const position: PagePosition | null = entryFor(json, { sha256: sha, size: t.size })?.position ?? null
      ready = true
      await completion().catch(() => {})
      return JSON.stringify(pageEntry({ sha256: t.sha256, size: t.size, name: t.name }, position, []))
    },
    loadHighlights,
    store(json) {
      if (take(json)) void save()
    },
    flush: () => (current() ? save() : Promise.resolve()),
    flushKeepalive(last) {
      if (last !== undefined) take(last)
      if (current()) void save()
    },
    complete() {
      if (!current() || !ready) return Promise.reject(new Error('the book is not open'))
      return (completing ??= (async () => {
        // The place on screen written first, as web writes it before the completion.
        await save()
        const json = await run(() => storage.readStore(sha))
        if (!live()) throw new Error('the book is not open')
        if (!entryFor(json, { sha256: sha, size: t.size })?.position) throw new Error(NO_PLACE_YET)
        await run(() => storage.finishBook(sha))
        const at = await completion()
        if (!at) throw new Error('the device did not keep the completion')
        sync()
        return at
      })().finally(() => { completing = null }))
    },
    note: noteOf,
    setNote(id, note) {
      if (!current() || isDeleted(id) || noteOf(id) === note) return
      notes.known.set(id, note)
      notes.unknown.delete(id)
      edit('note', () => storage.setNote(id, note))
    },
    remove(id) {
      if (!current() || isDeleted(id)) return
      notes.deleted.add(id)
      notes.known.delete(id)
      edit('highlight removal', () => storage.removeHighlight(id))
    },
    real,
    deleted: isDeleted,
    close(last) {
      if (closing) return closing
      if (last !== undefined) take(last)
      const pending = save()
      release()
      const done = closing = Promise.all([pending, completing?.catch(() => {}), chain]).then(() => {}).finally(() => {
        closed = true
        if (closingByBook.get(t.bookId) === done) closingByBook.delete(t.bookId)
      })
      closingByBook.set(t.bookId, done)
      return done
    },
  }
}
