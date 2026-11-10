/**
 * The V2 local library (R6, #1038; plan §8 row R6): one SQLite database, `textstack-v2` (never the
 * legacy `textstack-offline`), holding the V2 reader's books, reading state and highlights, keyed
 * by client v4 UUIDs (ADR-031 rule 3), plus the sync outbox and cursors. File bytes stay files
 * (`books/<sha256>.epub`, hostStorage.ts). The reading path reads only this: no network, no account.
 *
 * Tables:
 *   books          one row per book: the copy on this device (`file_id`, `sha256`, …; null when not
 *                  imported here), the server's current file as last seen (`server_*`; null when
 *                  the server has not seen the book), and `blocked`: why the server refused it for
 *                  good (it and its children are not sent until it changes)
 *   reading_state  per book: the page's position JSON and the server revision this device last saw
 *   annotations    the page's highlight JSON per id, its file version, revision and tombstone; `mine`
 *                  = made on this device
 *   outbox         what still has to be pushed: (kind, target), kind 'book' | 'state' | 'annotation',
 *                  pushed in that order (PDD "Push"). Coalescing: the payload is read from the row at
 *                  push time, so one entry per row; `gen` grows on every re-queue, so a push only
 *                  clears the entry it read (a save landing mid-push stays queued); `failures` counts
                  transient failures of that gen (a re-queue resets it; sync.ts `MAX_FAILURES`)
 *   meta           cursors per feed, the file-sync setting, the identity these rows synced with
 *
 * One serial queue runs every read and write (one connection: a read inside another job's open
 * transaction would see its uncommitted rows). A job is queued when its function is called, so a
 * write started in the tick an epoch was checked lands before a later sign-out's wipe.
 */
import { createWriteQueue } from '../sessionWrites'
import {
  annotationHighlight, decideServerState, isFractionOnly, isUuid, sameJson, statePosition, syncableText,
  type OpenReader, type PageHighlight, type PagePosition, type V2Annotation, type V2Book, type V2BookFile, type V2ReadingState,
} from '@textstack/shared'
import { entryFor, quoteOf, STORE_VERSION } from './store.mjs'
import type { LibraryBook } from './hostStorage'
import type { LibraryEntry } from './library.mjs'

/** The expo-sqlite surface this needs (node:sqlite behind a shim in tests). */
export interface Db {
  execAsync(sql: string): Promise<void>
  runAsync(sql: string, params?: unknown[]): Promise<unknown>
  getFirstAsync<T>(sql: string, params?: unknown[]): Promise<T | null>
  getAllAsync<T>(sql: string, params?: unknown[]): Promise<T[]>
  withTransactionAsync(fn: () => Promise<void>): Promise<void>
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    original_name TEXT NOT NULL,
    file_id TEXT, sha256 TEXT, size INTEGER, format TEXT,
    imported_at INTEGER, opened_at INTEGER,
    server_file_id TEXT, server_sha256 TEXT, server_size INTEGER, server_format TEXT,
    has_content INTEGER NOT NULL DEFAULT 0,
    content_removed INTEGER NOT NULL DEFAULT 0,
    removed_at TEXT,
    blocked TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS books_sha256 ON books (sha256);
  CREATE TABLE IF NOT EXISTS reading_state (
    book_id TEXT PRIMARY KEY,
    position TEXT,
    file_id TEXT,
    revision INTEGER,
    revision_file_id TEXT
  );
  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    file_id TEXT,
    highlight TEXT NOT NULL,
    revision INTEGER,
    deleted_at TEXT,
    mine INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS annotations_book ON annotations (book_id);
  CREATE TABLE IF NOT EXISTS outbox (
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    gen INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, target)
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`
/** Columns added after a dev build created the table; the duplicate-column error is the check (as offlineDb). */
const ADDED_COLUMNS = ['ALTER TABLE books ADD COLUMN blocked TEXT', 'ALTER TABLE outbox ADD COLUMN failures INTEGER NOT NULL DEFAULT 0']
/** SQLite's own text (sqlite3_errmsg), in node:sqlite's message and expo-sqlite's "Error code 1: …" alike. */
const isDuplicateColumn = (e: unknown) => /duplicate column name/i.test(String((e as Error | null)?.message ?? e))

/**
 * Failed attempts of one entry (same gen; every error that does not end the pass) before it stops
 * being retried: kept in the outbox, skipped until it is saved again, "Try again", the identity
 * changes or the next session (every count resets on a session's first pass: `retryAll`). PDD "Outbox".
 * ponytail: a per-session count, no time-based backoff, though a pass runs ~10 s after every save. Add
 * a `next_at` column with exponential delay if per-session retries prove too chatty.
 */
export const MAX_FAILURES = 5
/** A book's not-synced text when its entry or a child's stopped being retried: fixed, no error text. */
export const CHANGES_NOT_SYNCED = 'some changes not synced'
/** The book an outbox entry belongs to (its own entry, its state, its annotation): the one definition. */
const BOOK_OF = `CASE outbox.kind WHEN 'annotation' THEN (SELECT a.book_id FROM annotations a WHERE a.id = outbox.target) ELSE outbox.target END`

export interface BookRow {
  id: string
  title: string
  author: string
  original_name: string
  file_id: string | null
  sha256: string | null
  size: number | null
  format: string | null
  imported_at: number | null
  opened_at: number | null
  server_file_id: string | null
  server_sha256: string | null
  server_size: number | null
  server_format: string | null
  has_content: number
  content_removed: number
  removed_at: string | null
  blocked: string | null
}

export interface StateRow {
  book_id: string
  position: string | null
  file_id: string | null
  revision: number | null
  revision_file_id: string | null
}

export interface AnnotationRow {
  id: string
  book_id: string
  file_id: string | null
  highlight: string
  revision: number | null
  deleted_at: string | null
  mine: number
}

export type OutboxKind = 'book' | 'state' | 'annotation'
/** `failures`: transient push failures of this `gen` in a row (sync.ts `MAX_FAILURES`). */
export interface OutboxItem { kind: OutboxKind; target: string; gen: number; failures: number }

/** A host action the sync owes the open reader: go to `position` (`adopt`/`move`) or ask (`prompt`). */
export interface PositionAction {
  bookId: string
  action: 'adopt' | 'move' | 'prompt'
  position: PagePosition
}

export const FEEDS = ['library', 'reading', 'annotations'] as const
export type LocalFeed = (typeof FEEDS)[number]

const parse = <T>(json: string | null): T | null => {
  if (!json) return null
  try { return JSON.parse(json) as T } catch { return null }
}

/** An old (#1078-less) highlight: `quote` held the whole selection; now `selectedText` does and `quote` is its start. */
function normalised(h: PageHighlight): PageHighlight {
  return h.selectedText === undefined ? { ...h, selectedText: h.quote, quote: quoteOf(h.quote) } : h
}

/** A highlight's identity for the twin lookup: where it is and what it says. */
const twinKey = (h: PageHighlight | null) => (h ? `${h.cfi}\u0000${h.selectedText ?? h.quote}` : '')

/** The server's current file, as the `server_*` columns and `has_content`. */
const SERVER_FILE = 'server_file_id = ?, server_sha256 = ?, server_size = ?, server_format = ?, has_content = ?'
const serverFile = (f: V2BookFile | null | undefined) => [f?.id ?? null, f?.sha256 ?? null, f?.byteSize ?? null, f?.format ?? null, f?.hasContent ? 1 : 0]

export function createLocalLibrary(db: Db) {
  const queue = createWriteQueue()
  let ready: Promise<void> | null = null
  const migrate = async () => {
    await db.execAsync(SCHEMA)
    for (const alter of ADDED_COLUMNS) {
      // Only "already there" is swallowed: any other failure surfaces (a missing column would fail every save after).
      await db.execAsync(alter).catch((e) => { if (!isDuplicateColumn(e)) throw e })
    }
  }
  /** A job on the one queue; the schema runs before the first (a failed one is tried again). */
  const job = <T>(fn: () => Promise<T>): Promise<T> => queue.run(async () => {
    await (ready ??= migrate().catch((e) => { ready = null; throw e }))
    return fn()
  })
  const tx = <T>(fn: () => Promise<T>): Promise<T> => job(async () => {
    let out!: T
    await db.withTransactionAsync(async () => { out = await fn() })
    return out
  })

  const run = (sql: string, params: unknown[] = []) => db.runAsync(sql, params)
  const one = <T>(sql: string, params: unknown[] = []) => db.getFirstAsync<T>(sql, params)
  const all = <T>(sql: string, params: unknown[] = []) => db.getAllAsync<T>(sql, params)

  const bookById = (id: string) => one<BookRow>('SELECT * FROM books WHERE id = ?', [id])
  const bookBySha = (sha256: string) => one<BookRow>('SELECT * FROM books WHERE sha256 = ?', [sha256])
  /**
   * The book these bytes are: the local copy, else a pulled book not imported here whose current
   * file has them (its server position is this file's: picked before `addOpened` adopts it).
   */
  const bookForBytes = async (sha256: string) =>
    (await bookBySha(sha256)) ?? one<BookRow>('SELECT * FROM books WHERE imported_at IS NULL AND server_sha256 = ? ORDER BY rowid LIMIT 1', [sha256])
  /** The file version a book's rows on this device are read in. */
  const fileOf = (b: BookRow) => b.file_id ?? b.server_file_id
  const sizeOf = (b: BookRow) => b.size ?? b.server_size
  const stateOf = (bookId: string) => one<StateRow>('SELECT * FROM reading_state WHERE book_id = ?', [bookId])
  const annotationById = (id: string) => one<AnnotationRow>('SELECT * FROM annotations WHERE id = ?', [id])
  const queued = async (kind: OutboxKind, target: string) => !!(await one('SELECT 1 FROM outbox WHERE kind = ? AND target = ?', [kind, target]))
  /** A fresh save is a fresh attempt: a new gen, its failure count reset. */
  const enqueue = (kind: OutboxKind, target: string) =>
    run('INSERT INTO outbox (kind, target) VALUES (?, ?) ON CONFLICT (kind, target) DO UPDATE SET gen = gen + 1, failures = 0', [kind, target])
  /**
   * "Try again": a parked book is unparked and queued (one not parked is not re-sent); every queued
   * entry of it (its own, its state, its annotations) is retried from zero.
   */
  const unblock = async (bookId: string) => {
    if ((await bookById(bookId))?.blocked) {
      await run('UPDATE books SET blocked = NULL WHERE id = ?', [bookId])
      await enqueue('book', bookId)
    }
    await run(`UPDATE outbox SET failures = 0 WHERE ${BOOK_OF} = ?`, [bookId])
  }
  const dequeue = (kind: OutboxKind, target: string) => run('DELETE FROM outbox WHERE kind = ? AND target = ?', [kind, target])
  const getMeta = async (key: string) => (await one<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]))?.value ?? null
  const setMeta = (key: string, value: string | null) =>
    value === null ? run('DELETE FROM meta WHERE key = ?', [key]) : run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value])
  const clearCursors = () => run(`DELETE FROM meta WHERE key LIKE 'cursor:%'`)

  /**
   * The server's book onto its row: current file, removal, title and author (the server's metadata
   * wins). The server holds this book, so a park (a refusal of its import) no longer stands.
   */
  const setServer = (b: V2Book) => run(
    `UPDATE books SET ${SERVER_FILE}, content_removed = ?, removed_at = ?, title = ?, author = ?, blocked = NULL WHERE id = ?`,
    [...serverFile(b.currentFile), b.currentFile?.contentRemovedAt ? 1 : 0, b.removedAt, b.title, b.author ?? '', b.id],
  )

  /** The revision the next reading-state write names (the position untouched). */
  const upsertRevision = (bookId: string, revision: number | null, fileId: string | null) => run(
    `INSERT INTO reading_state (book_id, revision, revision_file_id) VALUES (?, ?, ?)
     ON CONFLICT (book_id) DO UPDATE SET revision = excluded.revision, revision_file_id = excluded.revision_file_id`,
    [bookId, revision, fileId],
  )

  /**
   * Book and file ids re-keyed everywhere they are named: a merge map, `duplicate_file`, an adopt by
   * sha256, `id_conflict` (PDD "Conflict codes"). A row already under the new id (a server-only copy
   * of the same book) is replaced by the re-keyed one. Idempotent: an id no longer present changes nothing.
   */
  async function rekeyIn(books: Record<string, string>, files: Record<string, string>) {
    for (const [from, to] of Object.entries(books)) {
      if (from === to) continue
      await run('UPDATE OR REPLACE books SET id = ? WHERE id = ?', [to, from])
      await run('UPDATE OR REPLACE reading_state SET book_id = ? WHERE book_id = ?', [to, from])
      await run('UPDATE annotations SET book_id = ? WHERE book_id = ?', [to, from])
      await run(`UPDATE OR REPLACE outbox SET target = ? WHERE target = ? AND kind IN ('book', 'state')`, [to, from])
    }
    for (const [from, to] of Object.entries(files)) {
      if (from === to) continue
      for (const [table, col] of [['books', 'file_id'], ['books', 'server_file_id'], ['reading_state', 'file_id'], ['reading_state', 'revision_file_id'], ['annotations', 'file_id']]) {
        await run(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [to, from])
      }
    }
  }

  /** A local book IS this server book (same bytes): the server's ids and metadata win; nothing left to push for it. */
  async function adoptIn(local: BookRow, server: V2Book) {
    const f = server.currentFile
    await rekeyIn({ [local.id]: server.id }, local.file_id && f && local.sha256 === f.sha256 ? { [local.file_id]: f.id } : {})
    await setServer(server)
    await dequeue('book', server.id)
  }

  /** A pulled book's server copy becomes this device's copy (picked bytes, or a download). */
  const importServerCopy = (id: string, format: string | null, now: number, openedAt?: number) => run(
    `UPDATE books SET file_id = server_file_id, sha256 = server_sha256, size = server_size, format = COALESCE(?, server_format),
       imported_at = ?, opened_at = COALESCE(?, opened_at) WHERE id = ?`,
    [format, now, openedAt ?? null, id],
  )

  /**
   * The page's entry into rows: a changed position queues a state write; a highlight new or changed
   * queues its annotation (only when its text may sync). A tombstoned highlight stays deleted (a
   * tombstone wins over every edit). A highlight under an id this book does not know — a pre-#1078
   * `h…` id, or one re-keyed after `id_conflict` while the page still holds the old one — is the
   * live highlight at the same CFI with the same text when there is one, else a new v4 id. One read
   * of the book's highlights per save (the hot path: every save debounce).
   */
  async function applyEntry(book: BookRow, entry: { position: PagePosition | null; highlights: PageHighlight[] }, newId: () => string, keepPosition = false) {
    const file = fileOf(book)
    if (entry.position) {
      const st = await stateOf(book.id)
      if (!(keepPosition && st?.position) && !sameJson(parse(st?.position ?? null), entry.position)) {
        await run(
          `INSERT INTO reading_state (book_id, position, file_id) VALUES (?, ?, ?)
           ON CONFLICT (book_id) DO UPDATE SET position = excluded.position, file_id = excluded.file_id`,
          [book.id, JSON.stringify(entry.position), file],
        )
        // A fraction-only position (#1187) is the server's own transitional locator: never pushed, never queued.
        if (!isFractionOnly(entry.position)) await enqueue('state', book.id)
      }
    }
    const rows = await all<Pick<AnnotationRow, 'id' | 'highlight' | 'deleted_at'>>('SELECT id, highlight, deleted_at FROM annotations WHERE book_id = ?', [book.id])
    const byId = new Map(rows.map((r) => [r.id, r]))
    const live = new Set(rows.filter((r) => !r.deleted_at).map((r) => twinKey(parse<PageHighlight>(r.highlight))))
    for (const raw of entry.highlights) {
      let h = normalised(raw)
      const row = isUuid(h.id) ? byId.get(h.id) : undefined
      if (!row) {
        if (live.has(twinKey(h))) continue
        if (!isUuid(h.id)) h = { ...h, id: newId() }
      }
      if (row?.deleted_at) continue
      const json = JSON.stringify(h)
      if (row && (row.highlight === json || sameJson(parse(row.highlight), h))) continue
      if (row) await run('UPDATE annotations SET highlight = ? WHERE id = ?', [json, h.id])
      else {
        await run('INSERT INTO annotations (id, book_id, file_id, highlight, mine) VALUES (?, ?, ?, ?, 1)', [h.id, book.id, file, json])
        byId.set(h.id, { id: h.id, highlight: json, deleted_at: null })
        live.add(twinKey(h))
      }
      if (syncableText(h)) await enqueue('annotation', h.id)
    }
  }

  return {
    // ---- The reading path (hostStorage) ----------------------------------------------------------

    /** Books on this device, in import order, then the server's that can be downloaded (bytes not already here). */
    books: (): Promise<LibraryBook[]> => job(async () => {
      const stuck = new Set((await all<{ id: string }>(`SELECT ${BOOK_OF} AS id FROM outbox WHERE failures >= ? GROUP BY 1`, [MAX_FAILURES])).map((r) => r.id))
      const rows = await all<BookRow>(
        `SELECT * FROM books WHERE imported_at IS NOT NULL
           OR (removed_at IS NULL AND has_content = 1 AND content_removed = 0 AND server_sha256 IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM books l WHERE l.sha256 = books.server_sha256))
         ORDER BY imported_at IS NULL, imported_at, rowid`,
      )
      return rows.map((b) => {
        const local = b.imported_at != null
        return {
          id: b.id, title: b.title, author: b.author, originalName: b.original_name,
          sha256: (local ? b.sha256 : b.server_sha256)!, size: (local ? b.size : b.server_size)!,
          importedAt: b.imported_at ?? 0, openedAt: b.opened_at ?? 0, local,
          notSynced: b.blocked ?? (stuck.has(b.id) ? CHANGES_NOT_SYNCED : null),
        }
      })
    }),

    /** Whether a book on this device already holds these bytes. */
    hasLocalBytes: (sha256: string) => job(async () => !!(await bookBySha(sha256))),

    /**
     * The opened file as a book: identical bytes are the existing book (its format learned if it was
     * not known; a parked book whose format changed is sent again); bytes a pulled book has (Story B4:
     * imported on another device) become that book with its ids; else a new book with new v4 ids,
     * queued for the server.
     */
    addOpened: (b: { sha256: string; size: number; title: string; author: string; originalName: string; format: string | null }, newId: () => string, now = Date.now()) =>
      tx(async () => {
        const existing = await bookBySha(b.sha256)
        if (existing) {
          await run('UPDATE books SET opened_at = ?, format = COALESCE(?, format) WHERE id = ?', [now, b.format, existing.id])
          if (existing.blocked && b.format && b.format !== existing.format) await unblock(existing.id)
          return existing.id
        }
        const pulled = await one<BookRow>('SELECT * FROM books WHERE imported_at IS NULL AND server_sha256 = ? AND server_size = ?', [b.sha256, b.size])
        if (pulled) {
          await importServerCopy(pulled.id, b.format, now, now)
          return pulled.id
        }
        const id = newId()
        await run('INSERT INTO books (id, title, author, original_name, file_id, sha256, size, format, imported_at, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          id, b.title.trim() || b.originalName.replace(/\.[a-z0-9]+$/i, ''), b.author.trim(), b.originalName, newId(), b.sha256, b.size, b.format, now, now,
        ])
        await enqueue('book', id)
        return id
      }),

    /** The page's entry for these bytes, rebuilt from the rows (null: no such book). Only highlights drawn in this file version. */
    readEntry: (sha256: string): Promise<string | null> => job(async () => {
      const book = await bookForBytes(sha256)
      if (!book) return null
      const st = await stateOf(book.id)
      const file = fileOf(book)
      const rows = await all<AnnotationRow>('SELECT highlight FROM annotations WHERE book_id = ? AND file_id = ? AND deleted_at IS NULL ORDER BY rowid', [book.id, file])
      return JSON.stringify({
        v: STORE_VERSION,
        book: { sha256, size: sizeOf(book), name: book.original_name },
        position: st && st.file_id === file ? parse(st.position) : null,
        highlights: rows.map((r) => parse<PageHighlight>(r.highlight)).filter(Boolean),
      })
    }),

    /** The page's `store` payload: rejected when it is not an entry for a book with these bytes. */
    writeEntry: (sha256: string, json: string, newId: () => string) => tx(async () => {
      const book = await bookForBytes(sha256)
      const entry = book && entryFor(json, { sha256, size: sizeOf(book) })
      if (!book || !entry) throw new Error(`not an entry for a library book: ${sha256}`)
      await applyEntry(book, entry, newId)
    }),

    /**
     * R2's JSON library (library.json + store/<sha256>.json) into the rows, once. Ids that are not
     * UUIDs (`lb_…` books, `h…` highlights, pre-#1078) get new v4 ids here, before anything is
     * uploaded. A store entry with no library book is not imported (it was never listed either). A
     * book already here (opened while an earlier import failed) keeps its row and position and gains
     * the entry's highlights. Resolves to the sha256s whose store entries the rows now hold.
     */
    importLegacy: (books: LibraryEntry[], storeOf: Map<string, string>, newId: () => string): Promise<string[]> => tx(async () => {
      if (await getMeta('legacy_imported')) return books.map((b) => b.sha256)
      for (const b of books) {
        const row = await bookBySha(b.sha256)
        if (!row) {
          const id = isUuid(b.id) ? b.id : newId()
          await run('INSERT INTO books (id, title, author, original_name, file_id, sha256, size, imported_at, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, b.title, b.author ?? '', b.originalName, newId(), b.sha256, b.size, b.importedAt, b.openedAt])
          await enqueue('book', id)
        }
        const json = storeOf.get(b.sha256)
        const entry = json ? entryFor(json, { sha256: b.sha256, size: b.size }) : null
        if (entry) await applyEntry((await bookBySha(b.sha256))!, entry, newId, !!row)
      }
      await setMeta('legacy_imported', '1')
      return books.map((b) => b.sha256)
    }),

    /**
     * `downloadV2Book` landed the server's bytes: the book is imported here. Never a second local row
     * for bytes another book already holds (books_sha256 is UNIQUE): false then, nothing changed.
     */
    markDownloaded: (bookId: string, now = Date.now()) => job(async () => {
      const b = await bookById(bookId)
      if (!b || b.imported_at != null || !b.server_sha256 || (await bookBySha(b.server_sha256))) return false
      await importServerCopy(bookId, null, now)
      return true
    }),

    // ---- The sync client (sync.ts) ---------------------------------------------------------------

    /** The queue in push order; one kind's entries in queue order. */
    outbox: (kind?: OutboxKind) => job(() => (kind
      ? all<OutboxItem>('SELECT kind, target, gen, failures FROM outbox WHERE kind = ? ORDER BY rowid', [kind])
      : all<OutboxItem>(`SELECT kind, target, gen, failures FROM outbox ORDER BY CASE kind WHEN 'book' THEN 0 WHEN 'state' THEN 1 ELSE 2 END, rowid`))),
    /**
     * What a pass pushes, one kind in queue order: entries still retried (under MAX_FAILURES) whose book
     * is not parked — a stuck entry or a parked book's child costs no read at all.
     */
    due: (kind: OutboxKind) => job(() => all<OutboxItem>(
      `SELECT kind, target, gen, failures FROM outbox WHERE kind = ? AND failures < ?
         AND NOT EXISTS (SELECT 1 FROM books b WHERE b.id = ${BOOK_OF} AND b.blocked IS NOT NULL) ORDER BY rowid`,
      [kind, MAX_FAILURES],
    )),
    /** A session's first pass: every entry retried again (an outage heals itself on the next launch). */
    retryAll: () => job(() => run('UPDATE outbox SET failures = 0 WHERE failures > 0')),
    /** The entry leaves the outbox only if it was not queued again since it was read. */
    done: (item: OutboxItem) => job(() => run('DELETE FROM outbox WHERE kind = ? AND target = ? AND gen = ?', [item.kind, item.target, item.gen])),
    /**
     * One more failed attempt, counted only against the gen that failed: the row's count now, or null
     * when it was queued again meanwhile (a save mid-push starts from zero).
     */
    failed: (item: OutboxItem) => job(async () => (await one<{ failures: number }>(
      'UPDATE outbox SET failures = failures + 1 WHERE kind = ? AND target = ? AND gen = ? RETURNING failures', [item.kind, item.target, item.gen],
    ))?.failures ?? null),
    /**
     * A child asks for its book: queued if it is not. An entry already queued keeps its gen and its
     * failure count (asking again every pass must not reset the count that parks a failing book).
     */
    queueBook: (id: string) => job(() => run(`INSERT INTO outbox (kind, target) VALUES ('book', ?) ON CONFLICT (kind, target) DO NOTHING`, [id])),
    /**
     * A book the server refused for good (`invalid_payload` and kin) is parked: neither it nor its
     * children are sent until it changes, "Try again", or the server turns out to hold it. Only while
     * the refused entry is current (`gen`): a newer one is left to its own attempt. True when it parked.
     */
    park: (item: OutboxItem, reason: string) => tx(async () => {
      if (!(await one('SELECT 1 FROM outbox WHERE kind = ? AND target = ? AND gen = ?', [item.kind, item.target, item.gen]))) return false
      await run('UPDATE books SET blocked = ? WHERE id = ?', [reason, item.target])
      await dequeue(item.kind, item.target)
      return true
    }),
    /** The reader's "Try again" (PDD "Outbox"): a parked book sent again; its children retried from zero, the book not re-sent if it was not parked. */
    unpark: (bookId: string) => tx(() => unblock(bookId)),
    book: (id: string) => job(() => bookById(id)),
    state: (bookId: string) => job(() => stateOf(bookId)),
    annotation: (id: string) => job(() => annotationById(id)),

    /** The server's book for a local one (import answer, `duplicate_file`, an adopt by sha256): its ids win. */
    adoptServerBook: (localId: string, server: V2Book) => tx(async () => {
      const local = await bookById(localId)
      if (local) await adoptIn(local, server)
    }),

    /** `id_conflict` on import: the id is someone else's; mint new book and file ids. */
    rekeyBook: (localId: string, newId: () => string) => tx(async () => {
      const local = await bookById(localId)
      if (!local) return localId
      const id = newId()
      await rekeyIn({ [localId]: id }, local.file_id ? { [local.file_id]: newId() } : {})
      return id
    }),

    /** The identity these rows last synced with. */
    account: () => job(() => getMeta('account')),
    setAccount: (userId: string) => job(() => setMeta('account', userId)),

    /**
     * PDD "Guest → account merge": the rows the guest `fromId` synced become the account's, in one
     * transaction — ids re-keyed by the merge map, every cursor dropped (the next pull is full), the
     * identity recorded. A library that synced as anyone else is left alone (false). A replay is
     * harmless: a re-key of an id no longer present changes nothing.
     */
    adoptAccount: (fromId: string, books: Record<string, string>, files: Record<string, string>, accountId: string) => tx(async () => {
      if ((await getMeta('account')) !== fromId) return false
      await rekeyIn(books, files)
      await clearCursors()
      await setMeta('account', accountId)
      return true
    }),

    setServerFile: (bookId: string, f: V2BookFile | null) => job(() => run(`UPDATE books SET ${SERVER_FILE} WHERE id = ?`, [...serverFile(f), bookId])),

    setHasContent: (bookId: string) => job(() => run('UPDATE books SET has_content = 1 WHERE id = ?', [bookId])),

    /** A reading-state write landed or lost to a row we keep ours over: the revision the next write names. */
    setStateRevision: (bookId: string, revision: number | null, fileId: string | null) => job(() => upsertRevision(bookId, revision, fileId)),

    /** An annotation as the server holds it (accepted, own write, kept server's, tombstone). */
    setAnnotation: (a: V2Annotation) => tx(async () => {
      const h = annotationHighlight(a)
      if (a.deletedAt) await run('UPDATE annotations SET revision = ?, deleted_at = ? WHERE id = ?', [a.revision, a.deletedAt, a.id])
      else if (h) await run('UPDATE annotations SET revision = ?, highlight = ?, file_id = ? WHERE id = ?', [a.revision, JSON.stringify(h), a.fileId, a.id])
      else await run('UPDATE annotations SET revision = ? WHERE id = ?', [a.revision, a.id])
    }),

    setAnnotationRevision: (id: string, revision: number) => job(() => run('UPDATE annotations SET revision = ? WHERE id = ?', [revision, id])),

    /** `id_conflict` on an annotation create: a new v4 id for it, here and in the outbox. */
    rekeyAnnotation: (id: string, newId: () => string) => tx(async () => {
      const row = await annotationById(id)
      if (!row) return id
      const to = newId()
      const h = { ...parse<PageHighlight>(row.highlight)!, id: to }
      await run('UPDATE annotations SET id = ?, highlight = ? WHERE id = ?', [to, JSON.stringify(h), id])
      await run(`UPDATE outbox SET target = ? WHERE kind = 'annotation' AND target = ?`, [to, id])
      return to
    }),

    /**
     * A library feed page, and its cursor in the same transaction (a page that fails to land is
     * pulled again). A pulled book is the local one with the same id; a local book never pushed with
     * the same bytes takes the server's ids (PDD "sha256 first"); anything else is kept as a book not
     * imported here. Removed books keep their local copy (owner decision 11: removal is a hide).
     */
    applyBooks: (items: V2Book[], cursor?: string | null) => tx(async () => {
      for (const b of items) {
        const f = b.currentFile
        if (await bookById(b.id)) {
          await setServer(b)
          continue
        }
        const twin = f && (await one<BookRow>('SELECT * FROM books WHERE sha256 = ? AND server_file_id IS NULL', [f.sha256]))
        if (twin) await adoptIn(twin, b)
        else if (!b.removedAt) {
          await run('INSERT INTO books (id, title, author, original_name) VALUES (?, ?, ?, ?)', [b.id, b.title, b.author ?? '', f?.originalName ?? b.title])
          await setServer(b)
        }
      }
      if (cursor !== undefined) await setMeta('cursor:library', cursor)
    }),

    /**
     * A reading feed page (and its cursor, in the same transaction). A row this device already has
     * (same revision and file) changes nothing. A book not imported here takes the server's position
     * (it restores once the bytes are here). Otherwise `decideServerState` (ADR-019 by CFI + spine
     * index): `keep` takes the revision only, `adopt`/`move` take the position and drop the queued
     * write, `prompt` takes the revision and keeps the reader's place queued. Returns what the open
     * reader is owed.
     */
    applyStates: (items: V2ReadingState[], reader: (bookId: string) => OpenReader | null, cursor?: string | null) => tx(async () => {
      const owed: PositionAction[] = []
      for (const s of items) {
        const book = await bookById(s.bookId)
        if (!book) continue
        const st = await stateOf(s.bookId)
        if (st?.revision === s.revision && st.revision_file_id === s.fileId) continue
        const position = statePosition(s)
        const setAll = () => run(
          `INSERT INTO reading_state (book_id, position, file_id, revision, revision_file_id) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (book_id) DO UPDATE SET position = excluded.position, file_id = excluded.file_id, revision = excluded.revision, revision_file_id = excluded.revision_file_id`,
          [s.bookId, JSON.stringify(position), s.fileId, s.revision, s.fileId],
        )
        if (book.imported_at == null) {
          await (position ? setAll() : upsertRevision(s.bookId, s.revision, s.fileId))
          continue
        }
        const local = st?.file_id === book.file_id ? parse<PagePosition>(st?.position ?? null) : null
        const action = decideServerState({ local, localFileId: book.file_id, server: s, reader: reader(s.bookId) })
        if (action === 'keep' || action === 'prompt') await upsertRevision(s.bookId, s.revision, s.fileId)
        else {
          await setAll()
          await dequeue('state', s.bookId)
        }
        if (action !== 'keep' && position) owed.push({ bookId: s.bookId, action, position })
      }
      if (cursor !== undefined) await setMeta('cursor:reading', cursor)
      return owed
    }),

    /**
     * An annotations feed page (and its cursor, in the same transaction): a tombstone always wins
     * (deleted here, its queued edit dropped); a row with a queued local edit is left for the push to
     * resolve (`stale_revision`); otherwise the server's row replaces the local copy. One the page
     * cannot draw (no `epub-cfi`) is not kept.
     */
    applyAnnotations: (items: V2Annotation[], cursor?: string | null) => tx(async () => {
      for (const a of items) {
        const row = await annotationById(a.id)
        if (a.deletedAt) {
          if (row) await run('UPDATE annotations SET deleted_at = ?, revision = ? WHERE id = ?', [a.deletedAt, a.revision, a.id])
          await dequeue('annotation', a.id)
          continue
        }
        if (await queued('annotation', a.id)) continue
        const h = annotationHighlight(a)
        if (!h) continue
        if (row) await run('UPDATE annotations SET highlight = ?, file_id = ?, revision = ? WHERE id = ?', [JSON.stringify(h), a.fileId, a.revision, a.id])
        else await run('INSERT INTO annotations (id, book_id, file_id, highlight, revision) VALUES (?, ?, ?, ?, ?)', [a.id, a.bookId, a.fileId, JSON.stringify(h), a.revision])
      }
      if (cursor !== undefined) await setMeta('cursor:annotations', cursor)
    }),

    cursor: (feed: LocalFeed) => job(() => getMeta(`cursor:${feed}`)),

    /** File sync (Story B5): off unless the reader turned it on. */
    fileSync: () => job(async () => (await getMeta('file_sync')) === '1'),
    setFileSync: (on: boolean) => job(() => setMeta('file_sync', on ? '1' : null)),

    /** Books whose bytes the server lacks and may take: on this device, pushed, current there, not stopped (`contentRemovedAt`). */
    uploadable: () => job(() => all<BookRow>(
      `SELECT * FROM books WHERE imported_at IS NOT NULL AND server_file_id = file_id AND has_content = 0 AND content_removed = 0 AND removed_at IS NULL`,
    )),

    /**
     * Another identity syncs this device now (sign-out, then another session): what the server told
     * the previous one goes — pulled books not imported here, others' highlights, revisions, server
     * files, parks, failure counts, cursors — and the new identity is recorded. This device's own books, positions,
     * highlights and queued writes stay: nothing unpushed is dropped (owner decision 3; #1070).
     */
    forgetServerState: (userId: string) => tx(async () => {
      await setMeta('account', userId)
      await run('DELETE FROM books WHERE imported_at IS NULL')
      await run(`DELETE FROM annotations WHERE mine = 0 AND id NOT IN (SELECT target FROM outbox WHERE kind = 'annotation')`)
      await run('DELETE FROM reading_state WHERE book_id NOT IN (SELECT id FROM books)')
      // A park's entry is gone (deleted when it parked): the new identity is sent every book it clears.
      for (const { id } of await all<{ id: string }>('SELECT id FROM books WHERE blocked IS NOT NULL')) await enqueue('book', id)
      await run('UPDATE books SET server_file_id = NULL, server_sha256 = NULL, server_size = NULL, server_format = NULL, has_content = 0, content_removed = 0, removed_at = NULL, blocked = NULL')
      await run('UPDATE reading_state SET revision = NULL, revision_file_id = NULL')
      await run('UPDATE annotations SET revision = NULL')
      await run('UPDATE outbox SET failures = 0')
      await clearCursors()
    }),
  }
}

export type LocalLibrary = ReturnType<typeof createLocalLibrary>
