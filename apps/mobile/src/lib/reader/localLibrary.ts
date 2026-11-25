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
 *   reading_state  per book: the page's position JSON, the server revision this device last saw, and
 *                  `completed_at` (#1266: the reader finished the book; set once, cleared only by a reset)
 *   annotations    the page's highlight JSON per id, its file version, revision and tombstone; `mine`
 *                  = made on this device; `note` the reader's note (#1312: the host's, the page holds none),
 *                  `note_dirty` = edited here and not yet on the server (a lost write's retry keeps the server's
 *                  note otherwise). A `deleted_at` with the row still queued is this device's removal, pushed
 *                  as a DELETE (#1312)
 *   vocabulary     #1271: the reader's live saved words, server cards only: the vocabulary feed's, and the card each
 *                  of this device's own saves answered with (a filled translation written to its row). What the reader
 *                  marks, offline too. Nothing here is queued (a save goes to the API first), so a wipe loses nothing
 *   reading_sessions  the reader's ended sessions (#1313, sessionTracker.mjs) by client session id, until pushed
 *                  (append-only facts: the row leaves with its outbox entry)
 *   outbox         what still has to be pushed: (kind, target), kind 'book' | 'state' | 'session' | 'annotation' |
 *                  'removal' (#1189: a book deleted here, its row gone), pushed in that order (PDD "Push"). Coalescing: the payload is read from the row at
 *                  push time, so one entry per row; `gen` grows on every re-queue, so a push only
 *                  clears the entry it read (a save landing mid-push stays queued); `failures` counts
                  transient failures of that gen (a re-queue resets it; sync.ts `MAX_FAILURES`)
 *   meta           cursors per feed, the file-sync setting, the identity these rows belong to
 *
 * One serial queue runs every read and write (one connection: a read inside another job's open
 * transaction would see its uncommitted rows). A job is queued when its function is called, so a
 * write started in the tick an epoch was checked lands before a later sign-out's wipe.
 */
import { createWriteQueue } from '../sessionWrites'
import {
  annotationHighlight, annotationQuotation, decideServerState, entryChanges, entryFor, isBookmark, isFractionOnly, isQuotation, isUuid, pageEntry, statePosition, syncableText,
  type OpenReader, type PageHighlight, type PagePosition, type PageQuotation, type Annotation, type Book, type BookFile, type ReadingState, type Word,
} from '@textstack/shared'
import type { LibraryBook } from './hostStorage'
import type { LibraryEntry } from '../../../../../packages/reader/src/library.mjs'

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
    blocked TEXT,
    upload_failures INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS books_sha256 ON books (sha256);
  CREATE TABLE IF NOT EXISTS reading_state (
    book_id TEXT PRIMARY KEY,
    position TEXT,
    file_id TEXT,
    revision INTEGER,
    revision_file_id TEXT,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    file_id TEXT,
    highlight TEXT NOT NULL,
    revision INTEGER,
    deleted_at TEXT,
    mine INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    note_dirty INTEGER NOT NULL DEFAULT 0,
    note_known INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS annotations_book ON annotations (book_id);
  DROP TABLE IF EXISTS annotation_aliases; -- made by dev builds of #1312 before its review; never used since
  CREATE TABLE IF NOT EXISTS reading_sessions (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    words_read INTEGER NOT NULL,
    start_percent REAL NOT NULL,
    end_percent REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outbox (
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    gen INTEGER NOT NULL DEFAULT 1,
    failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, target)
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS vocabulary (
    id TEXT PRIMARY KEY,
    word TEXT NOT NULL,
    language TEXT NOT NULL,
    stage INTEGER NOT NULL,
    translation TEXT
  );
`
/**
 * #1312 review: rows from before notes were kept here hold none, though the server may hold one, and every write now
 * sends the note (the PUT replaces the row). Once per database, in one transaction with its marker (a kill before it
 * commits runs it again at the next start): a row the server has (a revision) and no note edited here is marked not
 * known, never pushed until its note is (`pushAnnotation`), and the annotations feed is pulled again from the start.
 * A new database runs it on no rows.
 */
const NOTES_UPGRADE = 'upgrade:notes'
const NOTES_UPGRADE_SQL = `UPDATE annotations SET note_known = 0 WHERE revision IS NOT NULL AND note_dirty = 0;
  DELETE FROM meta WHERE key = 'cursor:annotations';
  INSERT INTO meta (key, value) VALUES ('${NOTES_UPGRADE}', '1');`
/** Columns added after a dev build created the table; the duplicate-column error is the check (as offlineDb). */
const ADDED_COLUMNS = [
  'ALTER TABLE books ADD COLUMN blocked TEXT',
  'ALTER TABLE outbox ADD COLUMN failures INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE reading_state ADD COLUMN completed_at TEXT',
  'ALTER TABLE annotations ADD COLUMN note TEXT',
  'ALTER TABLE annotations ADD COLUMN note_dirty INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE annotations ADD COLUMN note_known INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE books ADD COLUMN upload_failures INTEGER NOT NULL DEFAULT 0',
]
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
/** #1593: a book's not-synced text when the upload of its file (file sync) stopped being retried. */
export const FILE_NOT_UPLOADED = 'book file not uploaded'
/** The book an outbox entry belongs to (its own entry, its state, its annotation, its session): the one definition. */
const BOOK_OF = `CASE outbox.kind WHEN 'annotation' THEN (SELECT a.book_id FROM annotations a WHERE a.id = outbox.target)
  WHEN 'session' THEN (SELECT s.book_id FROM reading_sessions s WHERE s.id = outbox.target) ELSE outbox.target END`

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
  /** #1593: failed uploads of its bytes (file sync) since the last success, "Try again" or session's first pass; at MAX_FAILURES not retried. */
  upload_failures: number
}

export interface StateRow {
  book_id: string
  position: string | null
  file_id: string | null
  revision: number | null
  revision_file_id: string | null
  /** ISO time the reader finished the book (#1266); null: not finished. */
  completed_at: string | null
}

/** A book's last place on this device: `fraction` of the book (0..1), `at` epoch ms when the page took it (null: not said). */
export interface BookPlace {
  fraction: number
  at: number | null
}

export interface AnnotationRow {
  id: string
  book_id: string
  file_id: string | null
  highlight: string
  revision: number | null
  deleted_at: string | null
  mine: number
  /** The reader's note (null: none), and whether it was edited here since the server last had it. */
  note: string | null
  note_dirty: number
  /** 0: a row from before notes were kept, its server note not read yet (never pushed meanwhile). */
  note_known: number
}

export interface SessionRow {
  id: string
  book_id: string
  started_at: string
  ended_at: string
  duration_seconds: number
  words_read: number
  start_percent: number
  end_percent: number
}

export type OutboxKind = 'book' | 'state' | 'session' | 'annotation' | 'removal'
/**
 * #1271 review: what an own vocabulary write carries from the moment its save was asked: the user who asked, and
 * whether that session has ended since (`resetSince()`, the shared epoch: every sign-in and sign-out bumps it, so a
 * guest's save still in flight at sign-up is dropped; its card comes with the next pull under the account's id). Checked
 * inside the write's job against the library's owner then.
 */
export interface WriteGuard { user: string | null; stale: () => boolean }
/** #1271: a saved word as the reader marks it (the `vocabulary` row). */
export interface SavedWord { id: string; word: string; language: string; stage: number; translation: string | null }
/** #1312: a book's highlight notes as an editor needs them (`notes`). */
export interface BookNotes { known: Map<string, string | null>; unknown: Set<string>; deleted: Set<string> }
/** `failures`: transient push failures of this `gen` in a row (sync.ts `MAX_FAILURES`). */
export interface OutboxItem { kind: OutboxKind; target: string; gen: number; failures: number }

/** A host action the sync owes the open reader: go to `position` (`adopt`/`move`) or ask (`prompt`). */
export interface PositionAction {
  /** The book's bytes on this device: how the host knows its open book (an id can be re-keyed while it is read, #1303). */
  sha256: string | null
  action: 'adopt' | 'move' | 'prompt'
  position: PagePosition
}

export const FEEDS = ['library', 'reading', 'annotations', 'vocabulary'] as const
export type LocalFeed = (typeof FEEDS)[number]

const parse = <T>(json: string | null): T | null => {
  if (!json) return null
  try { return JSON.parse(json) as T } catch { return null }
}

/** #1593: a book still `uploadable` whose upload failed MAX_FAILURES times (the same predicate as that query). */
const uploadStopped = (b: BookRow) => b.upload_failures >= MAX_FAILURES && b.imported_at != null && b.server_file_id === b.file_id
  && !b.has_content && !b.content_removed && !b.removed_at

/** The server's current file, as the `server_*` columns and `has_content`. */
const SERVER_FILE = 'server_file_id = ?, server_sha256 = ?, server_size = ?, server_format = ?, has_content = ?'
const serverFile = (f: BookFile | null | undefined) => [f?.id ?? null, f?.sha256 ?? null, f?.byteSize ?? null, f?.format ?? null, f?.hasContent ? 1 : 0]

/** `meta` key: '1' when the owner (`meta.account`) is a guest. */
const OWNER_GUEST = 'account_guest'
/** Whom the library belongs to; null: nobody (never synced, or wiped). */
export type Owner = { id: string; guest: boolean } | null

/**
 * The library and an identity (#1070, owner 2026-11-12): `same` owner; `claim` an un-owned library;
 * `carry` a guest's library to whoever comes next (never wiped by an identity change); `foreign`
 * another real account's — wiped at sign-in (sync.ts `claimLibraryFor`), a sync pass only refuses.
 */
export function identityStep(owner: Owner, userId: string): 'same' | 'claim' | 'carry' | 'foreign' {
  if (!owner) return 'claim'
  if (owner.id === userId) return 'same'
  return owner.guest ? 'carry' : 'foreign'
}

/** What a wipe deletes that the server does not hold (#1070): device books, and other changes only here. */
export interface SignOutLoss { books: number; writes: number }
export const NOTHING_LOST: SignOutLoss = { books: 0, writes: 0 }

/**
 * Changes only on this device, one row per change, by book: queued positions, sessions and highlights, and own
 * highlights the server never took and nothing will send (over the cap, dropped after a refusal:
 * `mine`, no revision, not queued). Not counted (README "Sign-out"): an edit of a synced highlight dropped
 * after a refusal.
 */
const UNSENT_CHANGES = `
  SELECT target AS book_id FROM outbox WHERE kind = 'state'
  UNION ALL SELECT s.book_id FROM outbox o LEFT JOIN reading_sessions s ON s.id = o.target WHERE o.kind = 'session'
  UNION ALL SELECT a.book_id FROM outbox o LEFT JOIN annotations a ON a.id = o.target WHERE o.kind = 'annotation'
  UNION ALL SELECT book_id FROM annotations WHERE mine = 1 AND revision IS NULL AND deleted_at IS NULL
    AND id NOT IN (SELECT target FROM outbox WHERE kind = 'annotation')
  UNION ALL SELECT target FROM outbox WHERE kind = 'removal'`

/**
 * A book on this device is lost with its copy unless the server holds this very file with its bytes:
 * never pushed, pushed without bytes (file sync is opt-in), replaced since, bytes removed there, or the
 * book removed there (a hide: the server keeps no listed copy). A book not imported here has nothing to
 * lose. A change counts only when its book is not counted: a never-pushed book is one book, not also
 * its position and highlights.
 */
export function signOutLoss(
  books: Pick<BookRow, 'id' | 'imported_at' | 'file_id' | 'server_file_id' | 'has_content' | 'content_removed' | 'removed_at'>[],
  changes: { book_id: string | null }[],
): SignOutLoss {
  const onServer = (b: (typeof books)[number]) =>
    b.server_file_id !== null && b.server_file_id === b.file_id && !!b.has_content && !b.content_removed && !b.removed_at
  const lost = new Set(books.filter((b) => b.imported_at != null && !onServer(b)).map((b) => b.id))
  return { books: lost.size, writes: changes.filter((c) => !c.book_id || !lost.has(c.book_id)).length }
}

export function createLocalLibrary(db: Db) {
  const queue = createWriteQueue()
  let ready: Promise<void> | null = null
  const migrate = async () => {
    await db.execAsync(SCHEMA)
    for (const alter of ADDED_COLUMNS) {
      // Only "already there" is swallowed: any other failure surfaces (a missing column would fail every save after).
      await db.execAsync(alter).catch((e) => { if (!isDuplicateColumn(e)) throw e })
    }
    if (!(await db.getFirstAsync('SELECT 1 FROM meta WHERE key = ?', [NOTES_UPGRADE]))) await db.withTransactionAsync(() => db.execAsync(NOTES_UPGRADE_SQL))
    // #1593: failed uploads count per app run: every launch retries them, whatever its first pass did.
    await db.execAsync('UPDATE books SET upload_failures = 0 WHERE upload_failures > 0')
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
  const localBookId = (sha256: string) => job(async () => (await bookBySha(sha256))?.id ?? null)
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
  /**
   * #1312 review: re-keys made in this process (`id_conflict`), and (#1314 review) page ids skipped as a row's twin,
   * old → new, in memory only. The page keeps the old id until
   * the next open (its restore reads the rows: the new id); every way in resolves through `rekeyedTo` meanwhile: its
   * stores (`applyEntry`), `setNote`, `removeHighlight`, and the host's lookups (`realId`).
   */
  const rekeyed = new Map<string, string>()
  /** Followed to its end (a row re-keyed twice: old → mid → new), a cycle stopping it. */
  const rekeyedTo = (id: string) => {
    const seen = new Set<string>()
    while (rekeyed.has(id) && !seen.has(id)) {
      seen.add(id)
      id = rekeyed.get(id)!
    }
    return id
  }
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
    await run('UPDATE books SET upload_failures = 0 WHERE id = ?', [bookId])
  }
  const dequeue = (kind: OutboxKind, target: string) => run('DELETE FROM outbox WHERE kind = ? AND target = ?', [kind, target])
  /**
   * #1271 review: an own write lands only for the session that asked it (`stale`: the shared epoch, as sync's `checked`)
   * and only in a library that is nobody's or the asking user's (read inside the job, so nothing queued before a wipe
   * or another account's claim writes after it).
   */
  const ownedBy = async (g: WriteGuard) => {
    if (g.stale()) return false
    // The library now is nobody's, or the asking user's own (claimed mid-save, adopted to them): never another's.
    const now = await getMeta('account')
    return now === null || now === g.user
  }
  /** A vocabulary row from a server card (the feed's, or a save's answer): replaced by id. */
  const upsertWordRow = (w: { id: string; word: string; language: string; stage: number; translation?: string | null }) => run(
    `INSERT INTO vocabulary (id, word, language, stage, translation) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET word = excluded.word, language = excluded.language, stage = excluded.stage, translation = excluded.translation`,
    [w.id, w.word, w.language, w.stage, w.translation ?? null],
  )
  const getMeta = async (key: string) => (await one<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]))?.value ?? null
  const setMeta = (key: string, value: string | null) =>
    value === null ? run('DELETE FROM meta WHERE key = ?', [key]) : run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value])
  const clearCursors = () => run(`DELETE FROM meta WHERE key LIKE 'cursor:%'`)
  const setOwner = async (userId: string, guest: boolean) => {
    await setMeta('account', userId)
    await setMeta(OWNER_GUEST, guest ? '1' : null)
  }

  /**
   * The server's book onto its row: current file, removal, title and author (the server's metadata
   * wins). The server holds this book, so a park (a refusal of its import) no longer stands.
   */
  const setServer = (b: Book) => run(
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
      await run('UPDATE reading_sessions SET book_id = ? WHERE book_id = ?', [to, from])
      await run(`UPDATE OR REPLACE outbox SET target = ? WHERE target = ? AND kind IN ('book', 'state', 'removal')`, [to, from])
    }
    for (const [from, to] of Object.entries(files)) {
      if (from === to) continue
      for (const [table, col] of [['books', 'file_id'], ['books', 'server_file_id'], ['reading_state', 'file_id'], ['reading_state', 'revision_file_id'], ['annotations', 'file_id']]) {
        await run(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [to, from])
      }
    }
  }

  /** A local book IS this server book (same bytes): the server's ids and metadata win; nothing left to push for it. */
  async function adoptIn(local: BookRow, server: Book) {
    const f = server.currentFile
    await rekeyIn({ [local.id]: server.id }, local.file_id && f && local.sha256 === f.sha256 ? { [local.file_id]: f.id } : {})
    await setServer(server)
    await dequeue('book', server.id)
    // #1189: the bytes of a book deleted here opened again before its removal was pushed: the book is kept after all.
    await dequeue('removal', server.id)
  }

  /** A pulled book's server copy becomes this device's copy (picked bytes, or a download). */
  const importServerCopy = (id: string, format: string | null, now: number, openedAt?: number) => run(
    `UPDATE books SET file_id = server_file_id, sha256 = server_sha256, size = server_size, format = COALESCE(?, server_format),
       imported_at = ?, opened_at = COALESCE(?, opened_at) WHERE id = ?`,
    [format, now, openedAt ?? null, id],
  )

  /**
   * The page's entry into rows (the mapping is shared, `@textstack/shared` entryChanges): a changed position
   * queues a state write; a highlight new or changed queues its annotation (only when its text may sync).
   * One read of the book's highlights per save (the hot path: every save debounce).
   */
  async function applyEntry(book: BookRow, entry: { position: PagePosition | null; highlights: PageHighlight[] }, newId: () => string, keepPosition = false) {
    const file = fileOf(book)
    const st = await stateOf(book.id)
    const rows = await all<Pick<AnnotationRow, 'id' | 'highlight' | 'file_id' | 'deleted_at'>>('SELECT id, highlight, file_id, deleted_at FROM annotations WHERE book_id = ?', [book.id])
    // The page keeps a re-keyed highlight's old id until the next open: its forms are its row's (#1312 review).
    const highlights = rekeyed.size ? entry.highlights.map((h) => (rekeyed.has(h.id) ? { ...h, id: rekeyedTo(h.id) } : h)) : entry.highlights
    const changes = entryChanges(
      file,
      { position: parse(st?.position ?? null), highlights: rows.map((r) => ({ id: r.id, highlight: parse<PageHighlight>(r.highlight), fileId: r.file_id, deleted: !!r.deleted_at })) },
      { position: entry.position, highlights }, newId,
    )
    // A page id skipped as a row's twin is that row from now on (#1314 review: a bookmark the sync pulled while the book
    // was open, made again on the page): `removeHighlight`, `setNote` and `realId` reach the row, as after a re-key.
    for (const { from, to } of changes.aliases) if (!rekeyed.has(from)) rekeyed.set(from, to)
    if (changes.position && !(keepPosition && st?.position)) {
      await run(
        `INSERT INTO reading_state (book_id, position, file_id) VALUES (?, ?, ?)
         ON CONFLICT (book_id) DO UPDATE SET position = excluded.position, file_id = excluded.file_id`,
        [book.id, JSON.stringify(changes.position), file],
      )
      // A fraction-only position (#1187) is the server's own transitional locator: never pushed, never queued.
      if (!isFractionOnly(changes.position)) await enqueue('state', book.id)
    }
    for (const { highlight: h, isNew } of changes.highlights) {
      const json = JSON.stringify(h)
      if (isNew) await run('INSERT INTO annotations (id, book_id, file_id, highlight, mine) VALUES (?, ?, ?, ?, 1)', [h.id, book.id, file, json])
      else await run('UPDATE annotations SET highlight = ? WHERE id = ?', [json, h.id])
      if (syncableText(h)) await enqueue('annotation', h.id)
    }
  }

  return {
    // ---- The reading path (hostStorage) ----------------------------------------------------------

    /** Books on this device, in import order, then the server's that can be downloaded (bytes not already here). */
    books: (): Promise<LibraryBook[]> => job(async () => {
      const fileSync = (await getMeta('file_sync')) === '1'
      const stuck = new Set((await all<{ id: string }>(`SELECT ${BOOK_OF} AS id FROM outbox WHERE failures >= ? GROUP BY 1`, [MAX_FAILURES])).map((r) => r.id))
      const finished = new Map((await all<{ book_id: string; completed_at: string }>('SELECT book_id, completed_at FROM reading_state WHERE completed_at IS NOT NULL')).map((r) => [r.book_id, r.completed_at]))
      const rows = await all<BookRow>(
        `SELECT * FROM books WHERE imported_at IS NOT NULL
           OR (removed_at IS NULL AND has_content = 1 AND content_removed = 0 AND server_sha256 IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM books l WHERE l.sha256 = books.server_sha256))
           -- #1596: a book deleted here whose removal the server kept refusing: listed not synced, with Try again.
           OR id IN (SELECT target FROM outbox WHERE kind = 'removal' AND failures >= ?)
         ORDER BY imported_at IS NULL, imported_at, rowid`,
        [MAX_FAILURES],
      )
      return rows.map((b) => {
        const local = b.imported_at != null
        return {
          id: b.id, title: b.title, author: b.author, originalName: b.original_name,
          sha256: (local ? b.sha256 : b.server_sha256)!, size: (local ? b.size : b.server_size)!,
          importedAt: b.imported_at ?? 0, openedAt: b.opened_at ?? 0, local,
          notSynced: b.blocked ?? (stuck.has(b.id) ? CHANGES_NOT_SYNCED : fileSync && uploadStopped(b) ? FILE_NOT_UPLOADED : null),
          finished: finished.has(b.id),
          completedAt: finished.get(b.id) ?? null,
          format: (local ? b.format : b.server_format) ?? null,
        }
      })
    }),

    /** Each book's place here as a fraction of the book, and when the page took it: the Library's and book page's progress offline (#1532). */
    progress: () => job(async () => {
      const out = new Map<string, BookPlace>()
      for (const r of await all<{ book_id: string; position: string }>('SELECT book_id, position FROM reading_state WHERE position IS NOT NULL')) {
        const p = parse<PagePosition>(r.position)
        if (typeof p?.fraction === 'number') out.set(r.book_id, { fraction: p.fraction, at: p.at ?? null })
      }
      return out
    }),

    /** Whether a book on this device already holds these bytes. */
    hasLocalBytes: (sha256: string) => localBookId(sha256).then((id) => id !== null),
    /** The id of the book with these bytes here, as it is now (a sync may re-key it while it is read, #1303). */
    localBookId,
    /**
     * #1316: what a share of these bytes' text names on the server: the book's id as it is now, and its file only
     * when the server's current file is this very version (else the share carries no file: the text is not that
     * file's). Null: no book with these bytes here.
     */
    serverBookOf: (sha256: string) => job(async () => {
      const b = await bookBySha(sha256)
      return b ? { bookId: b.id, fileId: b.file_id !== null && b.file_id === b.server_file_id ? b.file_id : null } : null
    }),

    /**
     * The opened file as a book: identical bytes are the existing book (its format learned if it was
     * not known; a parked book whose format changed is sent again); bytes a pulled book has (Story B4:
     * imported on another device) become that book with its ids; else a new book with new v4 ids,
     * queued for the server. Its id is `localBookId(sha256)` (a sync may change it, #1303).
     */
    addOpened: (b: { sha256: string; size: number; title: string; author: string; originalName: string; format: string | null }, newId: () => string, now = Date.now()) =>
      tx(async (): Promise<void> => {
        const existing = await bookBySha(b.sha256)
        if (existing) {
          await run('UPDATE books SET opened_at = ?, format = COALESCE(?, format) WHERE id = ?', [now, b.format, existing.id])
          if (existing.blocked && b.format && b.format !== existing.format) await unblock(existing.id)
          return
        }
        const pulled = await one<BookRow>('SELECT * FROM books WHERE imported_at IS NULL AND server_sha256 = ? AND server_size = ?', [b.sha256, b.size])
        if (pulled) {
          await importServerCopy(pulled.id, b.format, now, now)
          return
        }
        const id = newId()
        await run('INSERT INTO books (id, title, author, original_name, file_id, sha256, size, format, imported_at, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          id, b.title.trim() || b.originalName.replace(/\.[a-z0-9]+$/i, ''), b.author.trim(), b.originalName, newId(), b.sha256, b.size, b.format, now, now,
        ])
        await enqueue('book', id)
      }),

    /** The page's entry for these bytes, rebuilt from the rows (null: no such book). Only highlights drawn in this file version. */
    readEntry: (sha256: string): Promise<string | null> => job(async () => {
      const book = await bookForBytes(sha256)
      if (!book) return null
      const st = await stateOf(book.id)
      const file = fileOf(book)
      const rows = await all<AnnotationRow>('SELECT highlight FROM annotations WHERE book_id = ? AND file_id = ? AND deleted_at IS NULL ORDER BY rowid', [book.id, file])
      const kept = rows.map((r) => parse<PageHighlight | PageQuotation>(r.highlight))
      return JSON.stringify(pageEntry(
        { sha256, size: sizeOf(book)!, name: book.original_name },
        st && st.file_id === file ? parse<PagePosition>(st.position) : null,
        kept.filter((h): h is PageHighlight => !!h && !isQuotation(h)),
        // #1195: the legacy anchor rows, listed by the page as quotations.
        kept.filter(isQuotation),
      ))
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
     * "Finish book" (#1266): the book is finished on this device now, and the state is queued so the server
     * learns it (sync.ts `pushState` sends `completedAt` with the position). Keyed by the bytes, not an id: a
     * sync can re-key the open book (an adopt by sha256) while it is read, and the row found here is its
     * current one. Set once (PDD "Reading state"): a finished book stays as it is and nothing is queued again
     * (a double tap). False: no such book here, or already finished.
     */
    finish: (sha256: string, at = new Date().toISOString()) => tx(async () => {
      const b = await bookBySha(sha256)
      if (!b || (await stateOf(b.id))?.completed_at) return false
      await run(
        `INSERT INTO reading_state (book_id, completed_at) VALUES (?, ?)
         ON CONFLICT (book_id) DO UPDATE SET completed_at = excluded.completed_at`,
        [b.id, at],
      )
      await enqueue('state', b.id)
      return true
    }),

    /**
     * A reading session ended (#1313): kept under a new client session id and queued for the server, for the book
     * with these bytes (its id at push time: a sync can re-key the open book while it is read). False: no such book.
     */
    addSession: (sha256: string, s: { startedAt: string; endedAt: string; durationSeconds: number; wordsRead: number; startPercent: number; endPercent: number }, newId: () => string) =>
      tx(async () => {
        const b = await bookBySha(sha256)
        if (!b) return false
        const id = newId()
        await run(
          'INSERT INTO reading_sessions (id, book_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, b.id, s.startedAt, s.endedAt, s.durationSeconds, s.wordsRead, s.startPercent, s.endPercent],
        )
        await enqueue('session', id)
        return true
      }),

    /**
     * #1312: the reader's note (null: none) on highlight `id`: this device's edit (`note_dirty`), queued when the
     * highlight's text may sync. False: no such highlight here, or it is deleted.
     */
    setNote: (pageId: string, note: string | null) => tx(async () => {
      const id = rekeyedTo(pageId)
      const row = await annotationById(id)
      if (!row || row.deleted_at) return false
      if ((row.note ?? null) === note && row.note_known) return true
      await run('UPDATE annotations SET note = ?, note_dirty = 1, note_known = 1 WHERE id = ?', [note, id])
      const h = parse<PageHighlight>(row.highlight)
      if (h && syncableText(h)) await enqueue('annotation', id)
      return true
    }),

    /**
     * #1312: the page removed highlight `id` (`highlight-removed`): deleted here at once (restore draws it no more and
     * a later `store` holding it is skipped, `entryChanges`), and queued so the server tombstones it (sync.ts pushes a
     * DELETE). One whose text may not sync was never sent: nothing queued. False: no such highlight, or deleted.
     */
    removeHighlight: (pageId: string, at = new Date().toISOString()) => tx(async () => {
      const id = rekeyedTo(pageId)
      const row = await annotationById(id)
      if (!row || row.deleted_at) return false
      await run('UPDATE annotations SET deleted_at = ? WHERE id = ?', [at, id])
      const h = parse<PageHighlight>(row.highlight)
      if (h && syncableText(h)) await enqueue('annotation', id)
      else await dequeue('annotation', id)
      return true
    }),

    /**
     * #1312: this device's live highlights in books on this device, in their current file version, newest first (at
     * most `limit`): the highlights screen's V2 section (dev route), which opens the reader at one.
     */
    deviceHighlights: (limit = 50) => job(async () => {
      const rows = await all<{ id: string; book_id: string; title: string; highlight: string; note: string | null }>(
        `SELECT a.id, a.book_id, b.title, a.highlight, a.note FROM annotations a JOIN books b ON b.id = a.book_id
         WHERE a.deleted_at IS NULL AND b.imported_at IS NOT NULL AND a.file_id = b.file_id ORDER BY a.rowid DESC LIMIT ?`,
        [limit],
      )
      return rows.flatMap((r) => {
        const h = parse<PageHighlight>(r.highlight)
        // Not a bookmark (#1314: the same rows, colour `bookmark`), nor a quotation (#1195: nowhere to open it at).
        // ponytail: filtered after the LIMIT, so bookmarks among the newest rows shorten this dev-only list; filter in SQL if it ships.
        return h && !isBookmark(h) && !isQuotation(h) ? [{ id: r.id, bookId: r.book_id, bookTitle: r.title, text: h.selectedText ?? h.quote, color: h.color ?? 'yellow', note: r.note }] : []
      })
    }),

    /** #1312 review: the id a page id is held under (after a re-key this process made, the new one). */
    realId: (id: string) => rekeyedTo(id),

    /**
     * #1312: the notes of the book with these bytes' highlights, for its list and editor, by the row's id and, for a row
     * re-keyed this process, by its old page id too (the page keeps that one until the next open).
     */
    notes: (sha256: string) => job(async () => {
      // The book these bytes are, as `readEntry` finds it (a pulled book not imported here yet included).
      const b = await bookForBytes(sha256)
      // `known`: live, note known (null: none). `unknown`: live, note not read yet (an editor waits). `deleted`: tombstoned
      // (a drawn one's editor closes). An id in none has no row yet: a highlight just made, no note (#1312 review).
      const rows = b ? await all<{ id: string; note: string | null; note_known: number; deleted_at: string | null }>(
        'SELECT id, note, note_known, deleted_at FROM annotations WHERE book_id = ?', [b.id]) : []
      const notes: BookNotes = { known: new Map(), unknown: new Set(), deleted: new Set() }
      for (const r of rows) {
        if (r.deleted_at) notes.deleted.add(r.id)
        else if (r.note_known) notes.known.set(r.id, r.note)
        else notes.unknown.add(r.id)
      }
      for (const old of rekeyed.keys()) {
        const now = rekeyedTo(old)
        if (notes.deleted.has(now)) notes.deleted.add(old)
        else if (notes.known.has(now)) notes.known.set(old, notes.known.get(now)!)
        else if (notes.unknown.has(now)) notes.unknown.add(old)
      }
      return notes
    }),

    /**
     * `downloadBook` landed the server's bytes: the book is imported here. Never a second local row
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
      : all<OutboxItem>(`SELECT kind, target, gen, failures FROM outbox ORDER BY CASE kind WHEN 'book' THEN 0 WHEN 'state' THEN 1 WHEN 'session' THEN 2 WHEN 'annotation' THEN 3 ELSE 4 END, rowid`))),
    /**
     * What a pass pushes, one kind in queue order: entries still retried (under MAX_FAILURES) whose book
     * is not parked — a stuck entry or a parked book's child costs no read at all.
     */
    due: (kind: OutboxKind) => job(() => all<OutboxItem>(
      `SELECT kind, target, gen, failures FROM outbox WHERE kind = ? AND failures < ?
         AND NOT EXISTS (SELECT 1 FROM books b WHERE b.id = ${BOOK_OF} AND b.blocked IS NOT NULL) ORDER BY rowid`,
      [kind, MAX_FAILURES],
    )),
    /** A session's first pass: every entry and upload retried again (an outage heals itself on the next launch). */
    retryAll: () => tx(async () => {
      await run('UPDATE outbox SET failures = 0 WHERE failures > 0')
      await run('UPDATE books SET upload_failures = 0 WHERE upload_failures > 0')
    }),
    /** The entry leaves the outbox only if it was not queued again since it was read; a session's row leaves with it. */
    done: (item: OutboxItem) => tx(async () => {
      await run('DELETE FROM outbox WHERE kind = ? AND target = ? AND gen = ?', [item.kind, item.target, item.gen])
      if (item.kind === 'session') await run(`DELETE FROM reading_sessions WHERE id = ? AND NOT EXISTS (SELECT 1 FROM outbox WHERE kind = 'session' AND target = ?)`, [item.target, item.target])
      // #1596: a deleted book's name (`removeBook`) leaves with its removal.
      if (item.kind === 'removal') await run(`DELETE FROM books WHERE id = ? AND imported_at IS NULL AND NOT EXISTS (SELECT 1 FROM outbox WHERE kind = 'removal' AND target = ?)`, [item.target, item.target])
    }),
    /**
     * One more failed attempt, counted only against the gen that failed: the row's count now, or null
     * when it was queued again meanwhile (a save mid-push starts from zero).
     */
    failed: (item: OutboxItem) => job(async () => {
      // Two statements in one queue job, not RETURNING: that needs SQLite 3.35, unverified on devices.
      const key = [item.kind, item.target, item.gen]
      await run('UPDATE outbox SET failures = failures + 1 WHERE kind = ? AND target = ? AND gen = ?', key)
      return (await one<{ failures: number }>('SELECT failures FROM outbox WHERE kind = ? AND target = ? AND gen = ?', key))?.failures ?? null
    }),
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
    /** A book deleted here (its removal queued) is no book, though its name is kept for the list (`removeBook`). */
    book: (id: string) => job(async () => ((await queued('removal', id)) ? null : bookById(id))),
    state: (bookId: string) => job(() => stateOf(bookId)),
    annotation: (id: string) => job(() => annotationById(id)),
    session: (id: string) => job(() => one<SessionRow>('SELECT * FROM reading_sessions WHERE id = ?', [id])),

    /** The server's book for a local one (import answer, `duplicate_file`, an adopt by sha256): its ids win. */
    adoptServerBook: (localId: string, server: Book) => tx(async () => {
      const local = await bookById(localId)
      if (!local) return
      // #1596: deleted here while its first push asked the server: the removal names the server's book; it stays deleted.
      if (await queued('removal', localId)) return void (await rekeyIn({ [localId]: server.id }, {}))
      await adoptIn(local, server)
    }),

    /** `id_conflict` on import: the id is someone else's; mint new book and file ids. */
    rekeyBook: (localId: string, newId: () => string) => tx(async () => {
      const local = await bookById(localId)
      if (!local) return localId
      const id = newId()
      await rekeyIn({ [localId]: id }, local.file_id ? { [local.file_id]: newId() } : {})
      return id
    }),

    /** The identity these rows belong to (null: nobody, e.g. after a wipe). */
    account: () => job(() => getMeta('account')),
    /** The owner and whether it is a guest (#1070: a guest's library carries over, an account's does not). */
    owner: () => job(async (): Promise<Owner> => {
      const id = await getMeta('account')
      return id === null ? null : { id, guest: (await getMeta(OWNER_GUEST)) === '1' }
    }),
    setAccount: (userId: string, guest = false) => job(() => setOwner(userId, guest)),

    /**
     * PDD "Guest → account merge": the rows the guest `fromId` synced become the account's, in one
     * transaction — ids re-keyed by the merge map, every cursor dropped (the next pull is full), the
     * identity recorded. A library that synced as anyone else is left alone (false). A replay is
     * harmless: a re-key of an id no longer present changes nothing.
     */
    adoptAccount: (fromId: string, books: Record<string, string>, files: Record<string, string>, accountId: string) => tx(async () => {
      if ((await getMeta('account')) !== fromId) return false
      await rekeyIn(books, files)
      // The guest's cards may survive under the account's ids (PDD merge: the account's id wins): the copy goes and the
      // full pull below brings the account's back, never a stale guest id beside it.
      await run('DELETE FROM vocabulary')
      await clearCursors()
      await setOwner(accountId, false)
      return true
    }),

    setServerFile: (bookId: string, f: BookFile | null) => job(() => run(`UPDATE books SET ${SERVER_FILE} WHERE id = ?`, [...serverFile(f), bookId])),

    setHasContent: (bookId: string) => job(() => run('UPDATE books SET has_content = 1, upload_failures = 0 WHERE id = ?', [bookId])),

    /** #1593: one more failed upload of the book's bytes: its count now (at MAX_FAILURES the list shows it not synced). */
    uploadFailed: (bookId: string) => job(async () => {
      await run('UPDATE books SET upload_failures = upload_failures + 1 WHERE id = ?', [bookId])
      return (await one<{ upload_failures: number }>('SELECT upload_failures FROM books WHERE id = ?', [bookId]))?.upload_failures ?? 0
    }),

    /** A reading-state write landed or lost to a row we keep ours over: the revision the next write names. */
    setStateRevision: (bookId: string, revision: number | null, fileId: string | null) => job(() => upsertRevision(bookId, revision, fileId)),

    /**
     * A reading-state write's answer as the server holds it (it landed, our own write found on a conflict, a
     * `reset` 409's current; null: none): its revision, and its `completedAt` (PDD: set once, cleared only by a
     * reset). `sent` is the completion that write carried: a finish tapped here while it was in flight is not
     * the write's to clear, so it stays unless the server has one.
     */
    takeState: (bookId: string, s: ReadingState | null, sent: string | null) => tx(async () => {
      await upsertRevision(bookId, s?.revision ?? null, s?.fileId ?? null)
      const theirs = s?.completedAt ?? null
      await run(
        'UPDATE reading_state SET completed_at = CASE WHEN completed_at IS ? THEN ? ELSE COALESCE(?, completed_at) END WHERE book_id = ?',
        [sent, theirs, theirs, bookId],
      )
    }),

    /** An annotation as the server holds it (accepted, own write, kept server's, tombstone). */
    setAnnotation: (a: Annotation) => tx(async () => {
      const h = annotationHighlight(a)
      if (a.deletedAt) await run('UPDATE annotations SET revision = ?, deleted_at = ? WHERE id = ?', [a.revision, a.deletedAt, a.id])
      else if (h) await run('UPDATE annotations SET revision = ?, highlight = ?, file_id = ?, note = ?, note_dirty = 0, note_known = 1 WHERE id = ?', [a.revision, JSON.stringify(h), a.fileId, a.noteText ?? null, a.id])
      else await run('UPDATE annotations SET revision = ?, note = ?, note_dirty = 0, note_known = 1 WHERE id = ?', [a.revision, a.noteText ?? null, a.id])
    }),

    setAnnotationRevision: (id: string, revision: number) => job(() => run('UPDATE annotations SET revision = ? WHERE id = ?', [revision, id])),

    /**
     * #1312: a write lost to another device's (`stale_revision`): its revision, and its note unless this device edited
     * the note (`note_dirty`, decided in the statement: an edit landing meanwhile is kept).
     */
    takeServerRevision: (id: string, revision: number, note: string | null) => job(() =>
      run('UPDATE annotations SET revision = ?, note = CASE WHEN note_dirty = 1 THEN note ELSE ? END, note_known = 1 WHERE id = ?', [revision, note, id])),

    /**
     * #1312 review: the annotations feed was read to its end. A row still not known is not on the server (a tombstone or
     * a live row would have come): its note is none, and it may be pushed.
     */
    annotationsPulled: () => job(() => run('UPDATE annotations SET note_known = 1 WHERE note_known = 0')),

    /** #1312: a write landed with note `sent`: its revision; the note is no longer this device's edit unless it changed since. */
    annotationLanded: (id: string, revision: number, sent: string | null) => job(() =>
      run('UPDATE annotations SET revision = ?, note_dirty = CASE WHEN note IS ? THEN 0 ELSE note_dirty END WHERE id = ?', [revision, sent, id])),

    /** `id_conflict` on an annotation create: a new v4 id for it, here and in the outbox. */
    rekeyAnnotation: (id: string, newId: () => string) => tx(async () => {
      const row = await annotationById(id)
      if (!row) return id
      const to = newId()
      const h = { ...parse<PageHighlight>(row.highlight)!, id: to }
      await run('UPDATE annotations SET id = ?, highlight = ? WHERE id = ?', [to, JSON.stringify(h), id])
      await run(`UPDATE outbox SET target = ? WHERE kind = 'annotation' AND target = ?`, [to, id])
      return to
      // Recorded once the transaction committed (a rolled-back re-key leaves no mapping).
    }).then((to) => { if (to !== id) rekeyed.set(id, to); return to }),

    /**
     * A library feed page, and its cursor in the same transaction (a page that fails to land is
     * pulled again). A pulled book is the local one with the same id; a local book never pushed with
     * the same bytes takes the server's ids (PDD "sha256 first"); anything else is kept as a book not
     * imported here. Removed books keep their local copy (owner decision 11: removal is a hide).
     */
    applyBooks: (items: Book[], cursor?: string | null) => tx(async () => {
      for (const b of items) {
        // #1189: deleted here, its removal not pushed yet: a pull still showing it live does not bring it back.
        if (await queued('removal', b.id)) continue
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
     *
     * Completion (#1266; PDD: set once, cleared only by a reset): the server's `completedAt` is taken; a
     * reset this device has not seen (`resetRevision` past the revision last seen on that file: the test
     * the server's `reset` 409 makes) drops the local one; otherwise the local one stays, and is still
     * owed to the server: an adopted position keeps the state queued so it is sent.
     */
    applyStates: (items: ReadingState[], reader: (sha256: string | null) => OpenReader | null, cursor?: string | null) => tx(async () => {
      const owed: PositionAction[] = []
      for (const s of items) {
        const book = await bookById(s.bookId)
        if (!book || (await queued('removal', s.bookId))) continue
        const st = await stateOf(s.bookId)
        if (st?.revision === s.revision && st.revision_file_id === s.fileId) continue
        // The format of the state's file: a PDF takes a page position only (#1128 S5).
        const format = s.fileId === book.file_id ? book.format : s.fileId === book.server_file_id ? book.server_format : null
        const position = statePosition(s, format)
        const setAll = () => run(
          `INSERT INTO reading_state (book_id, position, file_id, revision, revision_file_id) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (book_id) DO UPDATE SET position = excluded.position, file_id = excluded.file_id, revision = excluded.revision, revision_file_id = excluded.revision_file_id`,
          [s.bookId, JSON.stringify(position), s.fileId, s.revision, s.fileId],
        )
        const wasReset = s.resetRevision != null && st?.revision != null && st.revision_file_id === s.fileId && s.resetRevision > st.revision
        // Finished here on another file version (replaced since): not this file's completion.
        const otherFile = st?.revision_file_id != null && st.revision_file_id !== s.fileId
        const completed = s.completedAt ?? (wasReset || otherFile ? null : st?.completed_at ?? null)
        const setCompleted = () => run('UPDATE reading_state SET completed_at = ? WHERE book_id = ?', [completed, s.bookId])
        if (book.imported_at == null) {
          await (position ? setAll() : upsertRevision(s.bookId, s.revision, s.fileId))
          await setCompleted()
          continue
        }
        const local = st?.file_id === book.file_id ? parse<PagePosition>(st?.position ?? null) : null
        const action = decideServerState({ local, localFileId: book.file_id, server: s, reader: reader(book.sha256), format })
        if (action === 'keep' || action === 'prompt') await upsertRevision(s.bookId, s.revision, s.fileId)
        else {
          await setAll()
          // Finished here and the server does not know yet: the write stays owed, on the adopted position.
          if (completed && !s.completedAt) await enqueue('state', s.bookId)
          else await dequeue('state', s.bookId)
        }
        await setCompleted()
        if (action !== 'keep' && position) owed.push({ sha256: book.sha256, action, position })
      }
      if (cursor !== undefined) await setMeta('cursor:reading', cursor)
      return owed
    }),

    /**
     * An annotations feed page (and its cursor, in the same transaction): a tombstone always wins
     * (deleted here, its queued edit dropped); a row with a queued local edit is left for the push to
     * resolve (`stale_revision`); otherwise the server's row replaces the local copy. One the page
     * cannot draw (no `epub-cfi`) is not kept, except a legacy anchor one: kept as a quotation (#1195).
     */
    applyAnnotations: (items: Annotation[], cursor?: string | null) => tx(async () => {
      for (const a of items) {
        const row = await annotationById(a.id)
        if (a.deletedAt) {
          if (row) await run('UPDATE annotations SET deleted_at = ?, revision = ? WHERE id = ?', [a.deletedAt, a.revision, a.id])
          await dequeue('annotation', a.id)
          continue
        }
        if (await queued('annotation', a.id)) {
          // A queued row whose note was never read (from before notes were kept): its note now, the rest left to the push.
          // Never over a note edited here (not marked unknown by the upgrade; guarded here too).
          if (row && !row.note_known) await run('UPDATE annotations SET note = ?, note_known = 1 WHERE id = ? AND note_dirty = 0', [a.noteText ?? null, a.id])
          continue
        }
        // #1195: a legacy anchor annotation is kept as a quotation (listed, never drawn; syncableText refuses it, so it is
        // never queued nor written back).
        const h = annotationHighlight(a) ?? annotationQuotation(a)
        if (!h) continue
        if (row) await run('UPDATE annotations SET highlight = ?, file_id = ?, revision = ?, note = ?, note_dirty = 0, note_known = 1 WHERE id = ?', [JSON.stringify(h), a.fileId, a.revision, a.noteText ?? null, a.id])
        else await run('INSERT INTO annotations (id, book_id, file_id, highlight, revision, note) VALUES (?, ?, ?, ?, ?, ?)', [a.id, a.bookId, a.fileId, JSON.stringify(h), a.revision, a.noteText ?? null])
      }
      if (cursor !== undefined) await setMeta('cursor:annotations', cursor)
    }),

    /**
     * #1271: a vocabulary feed page (and its cursor, in the same transaction). The server's row replaces the local
     * copy; a tombstone removes it (a deleted word is unmarked). Nothing is queued: the copy is pull-only.
     */
    applyVocabulary: (items: Word[], cursor?: string | null) => tx(async () => {
      for (const w of items) {
        if (w.deletedAt) await run('DELETE FROM vocabulary WHERE id = ?', [w.id])
        else await upsertWordRow(w)
      }
      if (cursor !== undefined) await setMeta('cursor:vocabulary', cursor)
    }),

    /** #1271: every live saved word on this device, for the reader's marks (one read per open). */
    savedWords: () => job(() => all<SavedWord>('SELECT id, word, language, stage, translation FROM vocabulary ORDER BY rowid')),

    /**
     * #1271 review: the card a save of this device answered with (saved, already saved, restored, added anyway), as the
     * pull writes it: the server's card, by its id. A later pull replaces it by id, a tombstone deletes it.
     */
    upsertWord: (w: SavedWord, guard: WriteGuard) => job(async () => {
      if (!(await ownedBy(guard))) return false
      await upsertWordRow(w)
      return true
    }),

    /** The translation the server holds after a write (`onlyIfEmpty`: backfill, TR-2): on its row too, unless it has one. */
    setWordTranslation: (id: string, translation: string, guard: WriteGuard) => job(async () => {
      if (!(await ownedBy(guard))) return false
      await run('UPDATE vocabulary SET translation = ? WHERE id = ? AND translation IS NULL', [translation, id])
      return true
    }),

    cursor: (feed: LocalFeed) => job(() => getMeta(`cursor:${feed}`)),

    /** File sync (Story B5): off unless the reader turned it on. */
    fileSync: () => job(async () => (await getMeta('file_sync')) === '1'),
    setFileSync: (on: boolean) => job(() => setMeta('file_sync', on ? '1' : null)),

    /**
     * Books whose bytes the server lacks and may take: on this device, pushed, current there, not stopped (`contentRemovedAt`),
     * and not failed MAX_FAILURES times (#1593).
     */
    uploadable: () => job(() => all<BookRow>(
      `SELECT * FROM books WHERE imported_at IS NOT NULL AND server_file_id = file_id AND has_content = 0 AND content_removed = 0 AND removed_at IS NULL
         AND upload_failures < ?`,
      [MAX_FAILURES],
    )),

    /**
     * #1189: Delete Book on this device, in one transaction: the book's row, reading state, highlights, sessions and
     * every queued write of it, and a queued 'removal': the DELETE sync.ts pushes, and the tombstone that keeps a pull
     * from bringing it back (`applyBooks`). Always queued, even for a book this device never saw land on the server: its
     * first push may still be in flight, and a book the server lacks answers 404 (the entry dropped). Other devices
     * keep their copies (decision 11: a removal is a hide). The book's name stays, nothing else (#1596): a removal the
     * server keeps refusing is listed not synced (`books`); it leaves with the removal (`done`). Resolves to the sha256 of
     * the retained copy to delete (null: none here; books_sha256 is UNIQUE, so no other row holds those bytes).
     */
    removeBook: (bookId: string) => tx(async () => {
      const b = await bookById(bookId)
      // The outbox first: BOOK_OF reads the annotation and session rows.
      await run(`DELETE FROM outbox WHERE ${BOOK_OF} = ?`, [bookId])
      for (const table of ['reading_state', 'annotations', 'reading_sessions']) await run(`DELETE FROM ${table} WHERE book_id = ?`, [bookId])
      await run('DELETE FROM books WHERE id = ?', [bookId])
      if (b) await run('INSERT INTO books (id, title, author, original_name) VALUES (?, ?, ?, ?)', [b.id, b.title, b.author, b.original_name])
      await enqueue('removal', bookId)
      return b?.imported_at != null ? b.sha256 : null
    }),

    // ---- Sign-out and another account (#1070: V2 books belong to the account) ------------------

    /** What a wipe deletes that the server lacks (`signOutLoss`). */
    signOutLoss: () => job(async () => signOutLoss(
      await all<BookRow>('SELECT * FROM books'),
      await all<{ book_id: string | null }>(UNSENT_CHANGES),
    )),

    /**
     * A guest-owned library under the next identity (#1070 rule C, when `adoptAccount` failed or did not
     * run): what the server told the guest goes — pulled books not imported here, others' highlights,
     * revisions, server files, parks, failure counts, cursors — and the new owner is recorded. The
     * device's own books, positions, highlights and queued writes stay and go to the new identity.
     */
    forgetServerState: (userId: string, guest: boolean) => tx(async () => {
      await setOwner(userId, guest)
      await run('DELETE FROM books WHERE imported_at IS NULL')
      await run(`DELETE FROM annotations WHERE mine = 0 AND id NOT IN (SELECT target FROM outbox WHERE kind = 'annotation')`)
      await run('DELETE FROM reading_state WHERE book_id NOT IN (SELECT id FROM books)')
      // The guest's saved words are the server's knowledge (pull-only): gone, pulled again for the new identity.
      await run('DELETE FROM vocabulary')
      // A park's entry is gone (deleted when it parked): the new identity is sent every book it clears.
      for (const { id } of await all<{ id: string }>('SELECT id FROM books WHERE blocked IS NOT NULL')) await enqueue('book', id)
      await run('UPDATE books SET server_file_id = NULL, server_sha256 = NULL, server_size = NULL, server_format = NULL, has_content = 0, content_removed = 0, removed_at = NULL, blocked = NULL, upload_failures = 0')
      await run('UPDATE reading_state SET revision = NULL, revision_file_id = NULL')
      await run('UPDATE annotations SET revision = NULL')
      await run('UPDATE outbox SET failures = 0')
      await clearCursors()
    }),

    /**
     * Every row in one transaction, the owner included (#1070 rule A): an emptied library belongs to
     * nobody; rows that appear after it are taken by the first identity that syncs.
     */
    wipe: () => tx(async () => {
      for (const table of ['books', 'reading_state', 'annotations', 'reading_sessions', 'outbox', 'vocabulary']) await run(`DELETE FROM ${table}`)
      // The notes upgrade's marker stays (#1312 review): it is about this database, not its owner, and the rows a later
      // sign-in pulls are known, never to be marked unknown again.
      await run('DELETE FROM meta WHERE key <> ?', [NOTES_UPGRADE])
      // The re-key map once the rows it names are gone for good (committed).
    }).then(() => rekeyed.clear()),
  }
}

/**
 * Rows, then files (`clearFiles`: everything under the v2 root). A failed row wipe stops before the
 * files: rows never name missing files, and the owner left in place keeps every pass of another
 * account refused until the next sign-in wipes again (#1070).
 */
export async function wipeLibrary(lib: Pick<LocalLibrary, 'wipe'>, clearFiles: () => void): Promise<void> {
  await lib.wipe()
  clearFiles()
}

export type LocalLibrary = ReturnType<typeof createLocalLibrary>
