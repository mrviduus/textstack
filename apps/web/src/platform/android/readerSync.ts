/**
 * The Android reader's saving (ADR-035, #1642): the web `ReaderSync` contract (`lib/readerSync.ts`, what ReaderHost
 * calls) over the device library, as the Expo reader saves (`ReaderScreen.tsx` over `readerStorage()`). Local first:
 * - Every member reads and writes the device library only (`hostStorage`). No network, no account: reading,
 *   highlighting and the place all work offline. A sync pass (`syncSoon`, 10 s after the last save, as in Expo)
 *   pushes the outbox and resolves the conflicts later (ADR-019).
 * - No session epoch guard, as in the Expo reader: a guest mint or a sign-in while reading does not end the saves. The
 *   device library is the guard. After a wipe (sign-out, another account) it has no book with these bytes, so every
 *   write fails and the status is `unsaved`. Nothing is dropped in silence.
 * - `restore` gives the stored place only; `loadHighlights` the stored highlights (`onHighlights`), as the web host
 *   expects. The notes are the device's (`notes()`), kept in memory for the host's synchronous `note` / `deleted`.
 * - One queue of device writes. A save writes the page's latest `store` first, then the notes still to write (a note
 *   on a highlight whose row the next `store` makes waits for it). A failed write is `unsaved` and written again by
 *   the next save.
 * - While open, the book is the mounted reader of every pass (`holdReaderHost`): not restored until `restore`
 *   resolves (ADR-019 then adopts, as Expo), a reader who moved after it (web's `MOVED`), so a pulled place is kept or
 *   offered (`onNewerPlace`). The session never moves the reader (the web contract).
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

/** The open reader as a pass sees it, as the Expo `place.reader()`: not restored until `restore` resolves, then moved
 * (web's `MOVED`), so after it ADR-019 only keeps or asks. */
const NOT_RESTORED = { restoreApplied: false, moved: false, index: null }
const MOVED = { restoreApplied: true, moved: true, index: null }

/** The last session of each book's bytes still writing: the next one reads after it (web `closingByBook`; by bytes,
 * as a pass can re-key the id, #1303). */
const closingByBook = new Map<string, Promise<void>>()

type Options = Parameters<typeof createReaderSync>[1]

/** `deps`: the storage and the pass trigger (fakes in tests). */
export function createDeviceReaderSync(t: SyncTarget, o: Options, deps: { storage?: HostStorage; sync?: () => void } = {}): ReaderSync {
  const storage = deps.storage ?? readerStorage()
  const sync = deps.sync ?? syncAfterSave
  const sha = t.sha256.toLowerCase()
  let closed = false
  let closing: Promise<void> | null = null
  const current = () => !closed && !closing
  let ready = false
  /** A pulled place a pass adopted into the row before the restore read settled (ADR-019 `adopt`): the restore's. */
  let adopted: PagePosition | null = null
  let highlightsLoaded = o.highlights === false
  let pulling: Promise<void> | null = null
  /** The page's last payload taken, and the last one written. */
  let latest: string | null = null
  let saved: string | null = null
  let storeFailed = false
  /** A removal that did not land (Expo: an error, no retry): unsaved for the rest of this open. */
  let editFailed = false
  /** A note edit refused: the device never read that highlight's note (Expo `noteLoading`), so it is not written over. */
  let noteRefused = false
  /** Notes not on the device yet, by the page's id: written after the store of each save, kept until one lands. */
  const pendingNotes = new Map<string, string | null>()
  let completing: Promise<string> | null = null
  let notes: BookNotes = { known: new Map(), unknown: new Set(), deleted: new Set() }
  /** Edits made in memory: a notes read started before one is not taken. */
  let edits = 0

  /** Every device write of this session, in order. */
  let chain: Promise<unknown> = Promise.resolve()
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn)
    chain = p.catch(() => {})
    return p
  }

  const status = (s: SaveStatus) => { if (current()) o.onStatus(s) }
  const report = () => status(storeFailed || editFailed || noteRefused || pendingNotes.size
    ? 'unsaved'
    : highlightsLoaded || o.bookmarksOnly ? 'saved' : 'noHighlights')
  const completion = async () => {
    const at = (await storage.books()).find((b) => b.local && b.sha256 === sha)?.completedAt ?? null
    if (current()) o.onCompleted?.(at)
    return at
  }
  /** Until the first notes read lands, no note is known: none may be written over (`isUnknown`). */
  let notesRead = false
  /** The device's notes, with the notes still to write on top; one removed meanwhile is not written any more. */
  const takeNotes = (m: BookNotes, at: number) => {
    if (closed || at !== edits) return
    for (const [id, note] of pendingNotes) {
      if (m.deleted.has(id) || m.deleted.has(real(id))) pendingNotes.delete(id)
      else {
        m.known.set(id, note)
        m.unknown.delete(id)
      }
    }
    notes = m
    notesRead = true
  }
  const refreshNotes = () => {
    const at = edits
    run(() => storage.notes(sha)).then((m) => takeNotes(m, at), (e: unknown) => console.warn('[v2] notes not read:', e))
  }

  // The open book for every pass while this session is open: the hold is released by `close`.
  const release = holdReaderHost({
    ...openBookHost(() => (current() ? sha : null), () => (ready ? MOVED : NOT_RESTORED), (a) => {
      if (!current()) return
      // Adopted before the restore settled: the row holds it, the restore gives it. Else offered, never applied.
      if (a.action !== 'prompt' && !ready) adopted = a.position
      else o.onNewerPlace(a.position)
    }),
    // A pass may have pulled notes or a completion (a reset elsewhere brings the button back).
    passed: () => {
      if (!current()) return
      refreshNotes()
      completion().catch(() => {})
    },
  })

  /** The notes still to write. False from the device: no row yet (the next store makes it) or gone (dropped by the next read). */
  async function writeNotes() {
    for (const [id, note] of [...pendingNotes]) {
      try {
        if (!(await storage.setNote(id, note))) continue
        if (pendingNotes.get(id) === note) pendingNotes.delete(id)
        sync()
      } catch (e) {
        console.warn('[v2] note not saved on the device:', e)
      }
    }
    refreshNotes()
  }

  /**
   * The latest payload, then the pending notes; one queued save at a time, which takes the latest when it runs.
   * `load`: a highlights read not in yet is tried again (not on close: nobody would draw it).
   */
  let queued: Promise<void> | null = null
  function save(load = true): Promise<void> {
    if (load && !highlightsLoaded && current()) void loadHighlights()
    if ((latest === null || latest === saved) && !pendingNotes.size) return chain.then(() => {})
    return (queued ??= run(async () => {
      queued = null
      const json = latest
      if (json !== null && json !== saved) {
        try {
          await storage.writeStore(sha, json)
          saved = json
          storeFailed = false
          sync()
        } catch (e) {
          // A wiped library (sign-out, another account) has no book with these bytes: unsaved, never silent.
          console.warn('[v2] place not saved on the device:', e)
          storeFailed = true
        }
      }
      if (pendingNotes.size) await writeNotes()
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
        const at = edits
        // The notes with them: an editor opened on a drawn highlight shows its note.
        const [json, m] = await Promise.all([run(() => storage.readStore(sha)), run(() => storage.notes(sha))])
        if (closed) return
        const e = entryFor(json, { sha256: sha, size: t.size })
        takeNotes(m, at)
        if (!notesRead) refreshNotes()
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

  const real = (id: string) => storage.realId(id)
  const isDeleted = (id: string) => notes.deleted.has(id) || notes.deleted.has(real(id))
  const isUnknown = (id: string) => !notesRead || notes.unknown.has(id) || notes.unknown.has(real(id))
  const noteOf = (id: string) => notes.known.get(id) ?? notes.known.get(real(id)) ?? null

  return {
    target: t,
    async restore() {
      await (o.after ?? closingByBook.get(sha))?.catch(() => {})
      if (!current()) return null
      adopted = null
      // Throws when the entry cannot be read: the host offers a retry.
      const json = await run(() => storage.readStore(sha))
      if (!current()) return null
      const position: PagePosition | null = adopted ?? entryFor(json, { sha256: sha, size: t.size })?.position ?? null
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
        if (closed) throw new Error('the book is not open')
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
      if (isUnknown(id)) {
        console.warn(`[v2] note not saved: the note of highlight ${id} is not read on this device yet`)
        noteRefused = true
        return report()
      }
      edits++
      notes.known.set(id, note)
      pendingNotes.set(id, note)
      // After this tick: on pagehide the host writes the editor's note before it hands over the page's last store
      // (`flushKeepalive(last)`, `close(last)`), and that store may make the highlight's row.
      queueMicrotask(() => { if (!closed) void save() })
    },
    remove(id) {
      if (!current() || isDeleted(id)) return
      edits++
      notes.deleted.add(id)
      notes.known.delete(id)
      pendingNotes.delete(id)
      run(() => storage.removeHighlight(id)).then((done) => {
        if (!done) console.warn(`[v2] highlight removal: highlight ${id} is not held here`)
        refreshNotes()
        sync()
      }, (e: unknown) => {
        console.warn('[v2] highlight removal not saved:', e)
        editFailed = true
        refreshNotes()
        report()
      })
    },
    real,
    deleted: isDeleted,
    close(last) {
      if (closing) return closing
      if (last !== undefined) take(last)
      const pending = save(false)
      release()
      const done = closing = Promise.all([pending, completing?.catch(() => {}), chain]).then(() => {}).finally(() => {
        closed = true
        if (closingByBook.get(sha) === done) closingByBook.delete(sha)
      })
      closingByBook.set(sha, done)
      return done
    },
  }
}
