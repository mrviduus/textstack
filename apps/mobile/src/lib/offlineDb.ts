import { Platform } from 'react-native'
import type { ChapterNav, UserBookChapterDto } from '@textstack/shared'
import { createWriteQueue } from './sessionWrites'

/**
 * The open database, or the in-flight open.
 *
 * A promise rather than the handle: the detail screen and the reader both reach
 * for the cache on the same frame, and two callers arriving before the first
 * `openDatabaseAsync` resolved each opened their own connection and re-ran the
 * schema script. Storing the promise makes the second caller await the first.
 */
let dbPromise: Promise<any> | null = null

async function getDb(): Promise<any> {
  if (Platform.OS === 'web') return null
  if (!dbPromise) {
    dbPromise = (async () => {
      const SQLite = require('expo-sqlite')
      const opened = await SQLite.openDatabaseAsync('textstack-offline')
      // Every statement is CREATE TABLE IF NOT EXISTS and runs on every cold
      // start, so adding a table here is the whole migration for an install
      // that already has the first two. A new *column* is not — see the ALTER
      // below it. The catalog's `chapters` / `cached_books` retired at M6: dropped
      // on the next start, so a downloaded classic gives its space back.
      await opened.execAsync(`
        DROP TABLE IF EXISTS chapters;
        DROP TABLE IF EXISTS cached_books;
        CREATE TABLE IF NOT EXISTS user_chapters (
          book_id TEXT NOT NULL,
          chapter_slug TEXT NOT NULL,
          chapter_id TEXT NOT NULL,
          html TEXT NOT NULL,
          title TEXT NOT NULL,
          word_count INTEGER,
          chapter_number INTEGER,
          source_start_page INTEGER,
          prev_json TEXT,
          next_json TEXT,
          cached_at INTEGER NOT NULL,
          file_id TEXT,
          PRIMARY KEY (book_id, chapter_slug)
        );
        CREATE TABLE IF NOT EXISTS cached_user_books (
          book_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          author TEXT,
          cover_path TEXT,
          language TEXT,
          total_chapters INTEGER NOT NULL,
          cached_chapters INTEGER NOT NULL DEFAULT 0,
          total_word_count INTEGER,
          is_pdf INTEGER NOT NULL DEFAULT 0,
          cached_at INTEGER NOT NULL,
          file_id TEXT
        );
      `)
      // A column added after a table shipped: `CREATE TABLE IF NOT EXISTS` does
      // nothing for an install that already has the table, and SQLite has no
      // `ADD COLUMN IF NOT EXISTS`, so the duplicate-column error is the check.
      // V2 (#1025): the file version an upload's rows were cached from (null on legacy rows). The
      // key stays (book_id, chapter_slug) — on V2 the slug is the chapter key — and a replaced file
      // drops its book's rows (`dropReplacedUserBookFiles`), so a key can never serve another file's text.
      for (const alter of [
        'ALTER TABLE user_chapters ADD COLUMN file_id TEXT',
        'ALTER TABLE cached_user_books ADD COLUMN file_id TEXT',
      ]) {
        try {
          await opened.execAsync(alter)
        } catch {
          // Already there.
        }
      }
      return opened
    })().catch(err => {
      // A failed open must not poison every later call — drop the promise so
      // the next reader tries again rather than inheriting the rejection.
      dbPromise = null
      throw err
    })
  }
  return dbPromise
}

const txQueue = createWriteQueue()

/**
 * `withTransactionAsync`, one at a time (#1140). expo-sqlite's is a bare BEGIN/COMMIT on the shared
 * connection: a second one started while the first is open fails its BEGIN, and its ROLLBACK ends
 * the first's transaction. `withExclusiveTransactionAsync` is no fix here — it opens a second
 * connection and, with no busy timeout set, every concurrent write would fail `database is locked`.
 * ponytail: plain single-statement writes still interleave into an open transaction (committed with
 * it; lost only if it rolls back on an error) — route them through here if that ever bites.
 */
const inTransaction = (d: any, task: () => Promise<void>): Promise<void> => txQueue.run(() => d.withTransactionAsync(task))

type CachedUserBooksListener = (bookIds: string[]) => void
const cachedUserBooksListeners = new Set<CachedUserBooksListener>()

/**
 * Cached uploads changed behind the download engine (#1142): a V2 file replacement dropped rows, or
 * a guest → account merge re-keyed them. `bookIds` are the ids whose rows went (or moved away).
 */
export function onCachedUserBooksChanged(listener: CachedUserBooksListener): () => void {
  cachedUserBooksListeners.add(listener)
  return () => { cachedUserBooksListeners.delete(listener) }
}

function notifyCachedUserBooksChanged(bookIds: string[]) {
  // A throwing listener must not fail the write that already committed (nor skip the caller's cleanup).
  if (bookIds.length > 0) for (const l of cachedUserBooksListeners) try { l(bookIds) } catch (e) { console.warn('[offlineDb] change listener failed:', e) }
}

// ============ USER-UPLOADED BOOKS ============
//
// What is NOT cached: the original PDF of a PDF upload. The Original-layout
// viewer streams it with Range requests and a Bearer token (ADR-012), which
// needs the network. Offline, a PDF book opens in the reflow reader over these
// cached text chapters — `isPdf` is stored so the UI can say so up front rather
// than surprising the reader with a different-looking book on a train.

export interface CachedUserChapter {
  bookId: string
  chapterSlug: string
  chapterId: string
  html: string
  title: string
  wordCount: number | null
  chapterNumber: number | null
  sourceStartPage: number | null
  prev: ChapterNav | null
  next: ChapterNav | null
  cachedAt: number
}

export interface CachedUserBookMeta {
  bookId: string
  title: string
  author: string | null
  coverPath: string | null
  language: string | null
  totalChapters: number
  cachedChapters: number
  totalWordCount: number | null
  /** The upload is a PDF: offline it reads as extracted text, not as the original. */
  isPdf: boolean
  cachedAt: number
  /** V2: the file version cached; absent/null on legacy. */
  fileId?: string | null
}

type UserChapterRow = {
  book_id: string
  chapter_slug: string
  chapter_id: string
  html: string
  title: string
  word_count: number | null
  chapter_number: number | null
  source_start_page: number | null
  prev_json: string | null
  next_json: string | null
  cached_at: number
}

type UserBookRow = {
  book_id: string
  title: string
  author: string | null
  cover_path: string | null
  language: string | null
  total_chapters: number
  cached_chapters: number
  total_word_count: number | null
  is_pdf: number
  cached_at: number
  file_id: string | null
}

function toUserChapter(row: UserChapterRow): CachedUserChapter {
  return {
    bookId: row.book_id,
    chapterSlug: row.chapter_slug,
    chapterId: row.chapter_id,
    html: row.html,
    title: row.title,
    wordCount: row.word_count,
    chapterNumber: row.chapter_number,
    sourceStartPage: row.source_start_page,
    prev: row.prev_json ? JSON.parse(row.prev_json) : null,
    next: row.next_json ? JSON.parse(row.next_json) : null,
    cachedAt: row.cached_at,
  }
}

function toUserBookMeta(row: UserBookRow): CachedUserBookMeta {
  return {
    bookId: row.book_id,
    title: row.title,
    author: row.author,
    coverPath: row.cover_path,
    language: row.language,
    totalChapters: row.total_chapters,
    cachedChapters: row.cached_chapters,
    totalWordCount: row.total_word_count,
    isPdf: row.is_pdf === 1,
    cachedAt: row.cached_at,
    fileId: row.file_id ?? null,
  }
}

export async function getCachedUserChapter(
  bookId: string,
  chapterSlug: string,
): Promise<CachedUserChapter | null> {
  const d = await getDb()
  if (!d) return null
  const row = await d.getFirstAsync(
    'SELECT * FROM user_chapters WHERE book_id = ? AND chapter_slug = ?',
    [bookId, chapterSlug],
  ) as UserChapterRow | null
  return row ? toUserChapter(row) : null
}

export async function cacheUserChapter(
  bookId: string,
  chapter: UserBookChapterDto,
  chapterNumber: number | null,
): Promise<void> {
  const d = await getDb()
  if (!d) return
  await d.runAsync(
    `INSERT OR REPLACE INTO user_chapters
       (book_id, chapter_slug, chapter_id, html, title, word_count, chapter_number, source_start_page, prev_json, next_json, cached_at, file_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      bookId,
      chapter.slug,
      chapter.id,
      chapter.html,
      chapter.title,
      chapter.wordCount,
      chapterNumber,
      chapter.sourceStartPage ?? null,
      chapter.prev ? JSON.stringify(chapter.prev) : null,
      chapter.next ? JSON.stringify(chapter.next) : null,
      Date.now(),
      chapter.fileId ?? null,
    ],
  )
}

/** The same in-place refresh for an upload's chapter. `chapter_number` and
 *  `cached_at` are deliberately not in the SET list: the number came from the
 *  book payload at download time and is what `listCachedUserChapters` orders by. */
export async function refreshCachedUserChapter(
  bookId: string,
  chapter: UserBookChapterDto,
): Promise<void> {
  const d = await getDb()
  if (!d) return
  await d.runAsync(
    `UPDATE user_chapters
        SET chapter_id = ?, html = ?, title = ?, word_count = ?, source_start_page = COALESCE(?, source_start_page), prev_json = ?, next_json = ?,
            file_id = COALESCE(?, file_id)
      WHERE book_id = ? AND chapter_slug = ?`,
    [
      chapter.id,
      chapter.html,
      chapter.title,
      chapter.wordCount,
      chapter.sourceStartPage ?? null,
      chapter.prev ? JSON.stringify(chapter.prev) : null,
      chapter.next ? JSON.stringify(chapter.next) : null,
      chapter.fileId ?? null,
      bookId,
      chapter.slug,
    ],
  )
}

/** Fills the start pages of cached rows (RES-1): a download made before they were stored gains them. One transaction; never clears or rewrites one. */
export async function storeCachedUserChapterStartPages(
  bookId: string,
  chapters: readonly { slug: string; sourceStartPage?: number | null }[],
): Promise<void> {
  const d = await getDb()
  if (!d) return
  await inTransaction(d, async () => {
    for (const c of chapters) {
      if (c.sourceStartPage == null) continue
      await d.runAsync(
        'UPDATE user_chapters SET source_start_page = ? WHERE book_id = ? AND chapter_slug = ? AND source_start_page IS NULL',
        [c.sourceStartPage, bookId, c.slug],
      )
    }
  })
}

/**
 * The cached table of contents, in reading order.
 *
 * Ordered by `chapter_number` — not by `cached_at` the way the catalog listing
 * is. The number is stored at download time from the book payload, so a retry
 * that re-fetches chapter 9 after chapter 40 still lists them in the right
 * order. `COALESCE` keeps a row with no number (an older cache entry) at the
 * end rather than dropping it above everything.
 */
export async function listCachedUserChapters(bookId: string): Promise<CachedUserChapter[]> {
  const d = await getDb()
  if (!d) return []
  const rows = await d.getAllAsync(
    'SELECT * FROM user_chapters WHERE book_id = ? ORDER BY COALESCE(chapter_number, 999999) ASC, cached_at ASC',
    [bookId],
  ) as UserChapterRow[]
  return rows.map(toUserChapter)
}

/** Just the slugs and start pages, in reading order — the Library hero's Continue (RES-1) needs no HTML. */
export async function listCachedUserChapterPages(bookId: string): Promise<{ slug: string; sourceStartPage: number | null }[]> {
  const d = await getDb()
  if (!d) return []
  const rows = await d.getAllAsync(
    'SELECT chapter_slug, source_start_page FROM user_chapters WHERE book_id = ? ORDER BY COALESCE(chapter_number, 999999) ASC, cached_at ASC',
    [bookId],
  ) as { chapter_slug: string; source_start_page: number | null }[]
  return rows.map(r => ({ slug: r.chapter_slug, sourceStartPage: r.source_start_page }))
}

export async function getCachedUserBookMeta(bookId: string): Promise<CachedUserBookMeta | null> {
  const d = await getDb()
  if (!d) return null
  const row = await d.getFirstAsync(
    'SELECT * FROM cached_user_books WHERE book_id = ?',
    [bookId],
  ) as UserBookRow | null
  return row ? toUserBookMeta(row) : null
}

export async function setCachedUserBookMeta(meta: CachedUserBookMeta): Promise<void> {
  const d = await getDb()
  if (!d) return
  await d.runAsync(
    `INSERT OR REPLACE INTO cached_user_books
       (book_id, title, author, cover_path, language, total_chapters, cached_chapters, total_word_count, is_pdf, cached_at, file_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meta.bookId, meta.title, meta.author, meta.coverPath, meta.language,
      meta.totalChapters, meta.cachedChapters, meta.totalWordCount,
      meta.isPdf ? 1 : 0, meta.cachedAt, meta.fileId ?? null,
    ],
  )
}

export async function updateCachedUserChapterCount(bookId: string, cachedChapters: number): Promise<void> {
  const d = await getDb()
  if (!d) return
  await d.runAsync('UPDATE cached_user_books SET cached_chapters = ? WHERE book_id = ?', [cachedChapters, bookId])
}

export async function deleteCachedUserBook(bookId: string): Promise<void> {
  const d = await getDb()
  if (!d) return
  await d.runAsync('DELETE FROM user_chapters WHERE book_id = ?', [bookId])
  await d.runAsync('DELETE FROM cached_user_books WHERE book_id = ?', [bookId])
}

/**
 * V2: drop what this device cached from a file version that is no longer its book's current one
 * (replaced elsewhere), for the books of one library pull. Legacy rows (no file id) and books not in
 * the pull are left alone. Returns the books that lost rows: the caller drops their originals too.
 */
export async function dropReplacedUserBookFiles(current: { bookId: string; fileId: string }[]): Promise<string[]> {
  const d = await getDb()
  if (!d || current.length === 0) return []
  const currentFile = new Map(current.map(c => [c.bookId, c.fileId]))
  let dropped: string[] = []
  await inTransaction(d, async () => {
    const stored = await d.getAllAsync(
      'SELECT DISTINCT book_id, file_id FROM user_chapters WHERE file_id IS NOT NULL UNION SELECT book_id, file_id FROM cached_user_books WHERE file_id IS NOT NULL',
    ) as { book_id: string; file_id: string }[]
    dropped = [...new Set(stored.filter(r => currentFile.has(r.book_id) && currentFile.get(r.book_id) !== r.file_id).map(r => r.book_id))]
    for (const bookId of dropped) {
      const args = [bookId, currentFile.get(bookId)!]
      await d.runAsync('DELETE FROM user_chapters WHERE book_id = ? AND file_id IS NOT NULL AND file_id <> ?', args)
      await d.runAsync('DELETE FROM cached_user_books WHERE book_id = ? AND file_id IS NOT NULL AND file_id <> ?', args)
    }
  })
  notifyCachedUserBooksChanged(dropped)
  return dropped
}

export async function getAllCachedUserBooks(): Promise<CachedUserBookMeta[]> {
  const d = await getDb()
  if (!d) return []
  const rows = await d.getAllAsync('SELECT * FROM cached_user_books ORDER BY cached_at DESC') as UserBookRow[]
  return rows.map(toUserBookMeta)
}

/**
 * Drop every cached upload. Called on sign-out.
 *
 * The catalog cache deliberately survives a sign-out — an edition is public and
 * the download belongs to the device. An upload is the opposite: it is one
 * account's private file, and leaving its text in SQLite would hand it to
 * whoever signs in on this device next.
 */
export async function clearCachedUserBooks(): Promise<void> {
  const d = await getDb()
  if (!d) return
  // Through the queue (#1140 review): a bare DELETE could join another transaction and be undone by
  // its rollback — the previous account's text left for the next sign-in.
  await inTransaction(d, async () => {
    await d.runAsync('DELETE FROM user_chapters')
    await d.runAsync('DELETE FROM cached_user_books')
  })
}

/**
 * V2 guest → account merge: the rows cached under the guest's book and file ids move to the
 * account's (only the ids that changed). Where the account already has the same row on this device,
 * the account's wins and the guest's goes, so no key collides and one book never blocks the others.
 */
export async function rekeyCachedUserBooks(books: Record<string, string>, files: Record<string, string>): Promise<void> {
  const d = await getDb()
  if (!d) return
  await inTransaction(d, async () => {
    for (const [from, to] of Object.entries(books)) {
      await d.runAsync(
        'DELETE FROM user_chapters WHERE book_id = ? AND chapter_slug IN (SELECT chapter_slug FROM user_chapters WHERE book_id = ?)',
        [from, to],
      )
      await d.runAsync('DELETE FROM cached_user_books WHERE book_id = ? AND EXISTS (SELECT 1 FROM cached_user_books WHERE book_id = ?)', [from, to])
      await d.runAsync('UPDATE user_chapters SET book_id = ? WHERE book_id = ?', [to, from])
      await d.runAsync('UPDATE cached_user_books SET book_id = ? WHERE book_id = ?', [to, from])
    }
    for (const [from, to] of Object.entries(files)) {
      await d.runAsync('UPDATE user_chapters SET file_id = ? WHERE file_id = ?', [to, from])
      await d.runAsync('UPDATE cached_user_books SET file_id = ? WHERE file_id = ?', [to, from])
    }
  })
  // Old and new ids: one lost rows, the other gained them. The server builds `files` from the same
  // matched pairs as `books` (AccountMergeRepository), so every re-keyed file's book is in here. An id
  // with no rows here is a harmless re-read on a rare path.
  notifyCachedUserBooksChanged(Object.entries(books).flat())
}

/** Any local rows for this upload: a meta row, or chapters the reader cached while reading online
 *  with no meta row (#1174). A server-deleted book offers "Remove download" on this. */
export async function hasAnyUserBookCache(bookId: string): Promise<boolean> {
  const d = await getDb()
  if (!d) return false
  const row = await d.getFirstAsync(
    'SELECT 1 FROM cached_user_books WHERE book_id = ? UNION ALL SELECT 1 FROM user_chapters WHERE book_id = ? LIMIT 1',
    [bookId, bookId],
  )
  return row != null
}

/** `hasAnyUserBookCache` for every upload at once: book id -> whether any of its rows came from a V2
 *  file (`file_id` set) rather than the legacy store. What the deleted-on-server marking reads (#1193). */
export async function listUserBookCaches(): Promise<Map<string, boolean>> {
  const d = await getDb()
  if (!d) return new Map()
  const rows = await d.getAllAsync(
    'SELECT book_id, MAX(file_id IS NOT NULL) AS v2 FROM (SELECT book_id, file_id FROM cached_user_books UNION ALL SELECT book_id, file_id FROM user_chapters) GROUP BY book_id',
  ) as { book_id: string; v2: number }[]
  return new Map(rows.map(r => [r.book_id, r.v2 === 1]))
}

/** Bytes of chapter HTML these uploads hold in SQLite. ponytail: HTML only, not page or index
 *  overhead, so it under-states what deleting them would free; good enough to keep them off the budget. */
export async function userBookRowBytes(bookIds: string[]): Promise<number> {
  const d = await getDb()
  if (!d || bookIds.length === 0) return 0
  const row = await d.getFirstAsync(
    `SELECT COALESCE(SUM(LENGTH(CAST(html AS BLOB))), 0) AS bytes FROM user_chapters WHERE book_id IN (${bookIds.map(() => '?').join(',')})`,
    bookIds,
  ) as { bytes: number } | null
  return Number(row?.bytes ?? 0)
}

export async function isUserBookFullyCached(bookId: string): Promise<boolean> {
  const meta = await getCachedUserBookMeta(bookId)
  if (!meta) return false
  return meta.totalChapters > 0 && meta.cachedChapters >= meta.totalChapters
}
