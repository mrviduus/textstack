import { Platform } from 'react-native'
import type { Chapter, ChapterNav, UserBookChapterDto } from '@textstack/shared'

export interface CachedChapter {
  editionId: string
  chapterSlug: string
  /** The server's chapter id. Null on rows cached before 2026-09-28, when the
   *  column did not exist — highlights, bookmarks, vocabulary and the server
   *  progress write are all keyed by it, so a row without one can only be read. */
  chapterId: string | null
  html: string
  title: string
  wordCount: number | null
  prev: ChapterNav | null
  next: ChapterNav | null
  cachedAt: number
}

export interface CachedBookMeta {
  editionId: string
  slug: string
  title: string
  coverPath: string | null
  totalChapters: number
  cachedChapters: number
  cachedAt: number
}

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
      // below it.
      await opened.execAsync(`
        CREATE TABLE IF NOT EXISTS chapters (
          edition_id TEXT NOT NULL,
          chapter_slug TEXT NOT NULL,
          chapter_id TEXT,
          html TEXT NOT NULL,
          title TEXT NOT NULL,
          word_count INTEGER,
          prev_json TEXT,
          next_json TEXT,
          cached_at INTEGER NOT NULL,
          PRIMARY KEY (edition_id, chapter_slug)
        );
        CREATE TABLE IF NOT EXISTS cached_books (
          edition_id TEXT PRIMARY KEY,
          slug TEXT NOT NULL,
          title TEXT NOT NULL,
          cover_path TEXT,
          total_chapters INTEGER NOT NULL,
          cached_chapters INTEGER NOT NULL DEFAULT 0,
          cached_at INTEGER NOT NULL
        );
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
          cached_at INTEGER NOT NULL
        );
      `)
      // `chapters.chapter_id` is in the CREATE above for a fresh install and
      // here for every install that already has the table — `CREATE TABLE IF
      // NOT EXISTS` does nothing for those, and SQLite has no `ADD COLUMN IF
      // NOT EXISTS`, so the duplicate-column error is the check. Rows written
      // before the column existed keep a NULL id and stay readable; only the
      // writes that follow one need it.
      try {
        await opened.execAsync('ALTER TABLE chapters ADD COLUMN chapter_id TEXT')
      } catch {
        // Already there.
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

// ============ CHAPTERS ============

export async function getCachedChapter(
  editionId: string,
  chapterSlug: string,
): Promise<CachedChapter | null> {
  const d = await getDb()
  if (!d) return null
  const row = await d.getFirstAsync('SELECT * FROM chapters WHERE edition_id = ? AND chapter_slug = ?', [editionId, chapterSlug]) as {
    edition_id: string
    chapter_slug: string
    chapter_id: string | null
    html: string
    title: string
    word_count: number | null
    prev_json: string | null
    next_json: string | null
    cached_at: number
  } | null

  if (!row) return null
  return {
    editionId: row.edition_id,
    chapterSlug: row.chapter_slug,
    chapterId: row.chapter_id ?? null,
    html: row.html,
    title: row.title,
    wordCount: row.word_count,
    prev: row.prev_json ? JSON.parse(row.prev_json) : null,
    next: row.next_json ? JSON.parse(row.next_json) : null,
    cachedAt: row.cached_at,
  }
}

export async function cacheChapter(editionId: string, chapter: Chapter): Promise<void> {
  const d = await getDb()
  if (!d) return
  await d.runAsync(
    `INSERT OR REPLACE INTO chapters (edition_id, chapter_slug, chapter_id, html, title, word_count, prev_json, next_json, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      editionId,
      chapter.slug,
      chapter.id || null,
      chapter.html,
      chapter.title,
      chapter.wordCount,
      chapter.prev ? JSON.stringify(chapter.prev) : null,
      chapter.next ? JSON.stringify(chapter.next) : null,
      Date.now(),
    ],
  )
}

/**
 * Update a cached chapter's content in place, leaving `cached_at` alone.
 *
 * An `UPDATE` rather than `INSERT OR REPLACE`, and that is the whole point of
 * having a second function: a refresh must not create a row (only a download
 * decides what this device keeps) and must not restamp `cached_at`, which
 * `listCachedChapters` uses as its ordering key for want of a chapter number.
 * Re-caching with the insert would have sent every chapter the reader visited to
 * the bottom of the offline table of contents.
 */
export async function refreshCachedChapter(editionId: string, chapter: Chapter): Promise<void> {
  const d = await getDb()
  if (!d) return
  await d.runAsync(
    `UPDATE chapters
        SET chapter_id = ?, html = ?, title = ?, word_count = ?, prev_json = ?, next_json = ?
      WHERE edition_id = ? AND chapter_slug = ?`,
    [
      chapter.id || null,
      chapter.html,
      chapter.title,
      chapter.wordCount,
      chapter.prev ? JSON.stringify(chapter.prev) : null,
      chapter.next ? JSON.stringify(chapter.next) : null,
      editionId,
      chapter.slug,
    ],
  )
}

/**
 * Minimal chapter listing for offline rendering. Cache only stores the
 * fields we had at download time — no chapterNumber, so we sort by
 * cachedAt to roughly preserve reading order (chapters are downloaded in
 * sequence in DownloadContext).
 */
export interface CachedChapterSummary {
  /** Null on rows cached before the column existed. */
  chapterId: string | null
  slug: string
  title: string
  wordCount: number | null
}

export async function listCachedChapters(editionId: string): Promise<CachedChapterSummary[]> {
  const d = await getDb()
  if (!d) return []
  const rows = await d.getAllAsync(
    'SELECT chapter_id, chapter_slug, title, word_count FROM chapters WHERE edition_id = ? ORDER BY cached_at ASC',
    [editionId],
  ) as { chapter_id: string | null; chapter_slug: string; title: string; word_count: number | null }[]
  return rows.map(r => ({
    chapterId: r.chapter_id,
    slug: r.chapter_slug,
    title: r.title,
    wordCount: r.word_count,
  }))
}

// ============ BOOK META ============

export async function getCachedBookMeta(editionId: string): Promise<CachedBookMeta | null> {
  const d = await getDb()
  if (!d) return null
  const row = await d.getFirstAsync('SELECT * FROM cached_books WHERE edition_id = ?', [editionId]) as {
    edition_id: string
    slug: string
    title: string
    cover_path: string | null
    total_chapters: number
    cached_chapters: number
    cached_at: number
  } | null

  if (!row) return null
  return {
    editionId: row.edition_id,
    slug: row.slug,
    title: row.title,
    coverPath: row.cover_path,
    totalChapters: row.total_chapters,
    cachedChapters: row.cached_chapters,
    cachedAt: row.cached_at,
  }
}

export async function setCachedBookMeta(meta: CachedBookMeta): Promise<void> {
  const d = await getDb()
  if (!d) return
  await d.runAsync(
    `INSERT OR REPLACE INTO cached_books (edition_id, slug, title, cover_path, total_chapters, cached_chapters, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [meta.editionId, meta.slug, meta.title, meta.coverPath, meta.totalChapters, meta.cachedChapters, meta.cachedAt],
  )
}

export async function updateCachedChapterCount(editionId: string, cachedChapters: number): Promise<void> {
  const d = await getDb()
  if (!d) return
  await d.runAsync('UPDATE cached_books SET cached_chapters = ? WHERE edition_id = ?', [cachedChapters, editionId])
}

export async function deleteCachedBook(editionId: string): Promise<void> {
  const d = await getDb()
  if (!d) return
  await d.runAsync('DELETE FROM chapters WHERE edition_id = ?', [editionId])
  await d.runAsync('DELETE FROM cached_books WHERE edition_id = ?', [editionId])
}

export async function getAllCachedBooks(): Promise<CachedBookMeta[]> {
  const d = await getDb()
  if (!d) return []
  const rows = await d.getAllAsync('SELECT * FROM cached_books ORDER BY cached_at DESC') as {
    edition_id: string
    slug: string
    title: string
    cover_path: string | null
    total_chapters: number
    cached_chapters: number
    cached_at: number
  }[]

  return rows.map((row: any) => ({
    editionId: row.edition_id,
    slug: row.slug,
    title: row.title,
    coverPath: row.cover_path,
    totalChapters: row.total_chapters,
    cachedChapters: row.cached_chapters,
    cachedAt: row.cached_at,
  }))
}

export async function isBookFullyCached(editionId: string): Promise<boolean> {
  const meta = await getCachedBookMeta(editionId)
  if (!meta) return false
  return meta.cachedChapters >= meta.totalChapters
}

// ============ USER-UPLOADED BOOKS ============
//
// A parallel pair of tables rather than a `kind` column on the two above. The
// keys are different things — an edition id is public and shared, a user-book id
// is private to one account — and the catalog rows carry a slug the reader
// routes on, which a user book has no use for (its route key IS the id). Mixing
// them would mean a nullable slug and a discriminator on every query.
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
       (book_id, chapter_slug, chapter_id, html, title, word_count, chapter_number, source_start_page, prev_json, next_json, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        SET chapter_id = ?, html = ?, title = ?, word_count = ?, source_start_page = COALESCE(?, source_start_page), prev_json = ?, next_json = ?
      WHERE book_id = ? AND chapter_slug = ?`,
    [
      chapter.id,
      chapter.html,
      chapter.title,
      chapter.wordCount,
      chapter.sourceStartPage ?? null,
      chapter.prev ? JSON.stringify(chapter.prev) : null,
      chapter.next ? JSON.stringify(chapter.next) : null,
      bookId,
      chapter.slug,
    ],
  )
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
       (book_id, title, author, cover_path, language, total_chapters, cached_chapters, total_word_count, is_pdf, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meta.bookId, meta.title, meta.author, meta.coverPath, meta.language,
      meta.totalChapters, meta.cachedChapters, meta.totalWordCount,
      meta.isPdf ? 1 : 0, meta.cachedAt,
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
  await d.runAsync('DELETE FROM user_chapters')
  await d.runAsync('DELETE FROM cached_user_books')
}

export async function isUserBookFullyCached(bookId: string): Promise<boolean> {
  const meta = await getCachedUserBookMeta(bookId)
  if (!meta) return false
  return meta.totalChapters > 0 && meta.cachedChapters >= meta.totalChapters
}
