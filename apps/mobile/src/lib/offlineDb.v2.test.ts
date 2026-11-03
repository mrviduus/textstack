/**
 * offlineDb's V2 SQL on a real SQLite (#1025 M2.7, from QA's probes; node:sqlite behind an
 * expo-sqlite-shaped shim): the migration on an install that predates `file_id`, run on two cold
 * starts; `dropReplacedUserBookFiles`; `rekeyCachedUserBooks`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

let db: DatabaseSync

/** expo-sqlite's async surface over one node:sqlite connection. */
function shim(d: DatabaseSync) {
  return {
    execAsync: async (sql: string) => { d.exec(sql) },
    runAsync: async (sql: string, params: unknown[] = []) => {
      const r = d.prepare(sql).run(...(params.map((p) => (p === undefined ? null : p)) as never[]))
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) }
    },
    getFirstAsync: async (sql: string, params: unknown[] = []) => d.prepare(sql).get(...(params.map((p) => (p === undefined ? null : p)) as never[])) ?? null,
    getAllAsync: async (sql: string, params: unknown[] = []) => d.prepare(sql).all(...(params.map((p) => (p === undefined ? null : p)) as never[])),
    withTransactionAsync: async (fn: () => Promise<void>) => {
      d.exec('BEGIN')
      try { await fn(); d.exec('COMMIT') } catch (e) { d.exec('ROLLBACK'); throw e }
    },
  }
}

// offlineDb loads expo-sqlite with a plain `require`, which vi.mock does not reach: seed Node's cache.
const req = createRequire(import.meta.url)
const sqlitePath = req.resolve('expo-sqlite')
req.cache[sqlitePath] = { id: sqlitePath, filename: sqlitePath, loaded: true, exports: { openDatabaseAsync: async () => shim(db) } } as never

/** A cold start: a fresh module (its db promise empty) over the same file. */
const coldStart = async () => {
  vi.resetModules()
  return import('./offlineDb')
}

/** The schema an install had before this branch: no file_id on either upload table. */
function oldInstall() {
  db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE user_chapters (book_id TEXT NOT NULL, chapter_slug TEXT NOT NULL, chapter_id TEXT NOT NULL, html TEXT NOT NULL,
      title TEXT NOT NULL, word_count INTEGER, chapter_number INTEGER, source_start_page INTEGER, prev_json TEXT, next_json TEXT,
      cached_at INTEGER NOT NULL, PRIMARY KEY (book_id, chapter_slug));
    CREATE TABLE cached_user_books (book_id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT, cover_path TEXT, language TEXT,
      total_chapters INTEGER NOT NULL, cached_chapters INTEGER NOT NULL DEFAULT 0, total_word_count INTEGER,
      is_pdf INTEGER NOT NULL DEFAULT 0, cached_at INTEGER NOT NULL);
    INSERT INTO user_chapters VALUES ('legacy-b', 's1', 'c1', '<p>old</p>', 'One', 10, 1, NULL, NULL, NULL, 1);
    INSERT INTO cached_user_books VALUES ('legacy-b', 'Old', NULL, NULL, 'en', 1, 1, 10, 0, 1);
  `)
}

const ch = (slug: string, fileId: string | null) =>
  ({ id: slug, slug, title: slug, html: `<p>${slug}</p>`, wordCount: 1, prev: null, next: null, fileId })
const meta = (bookId: string, fileId: string | null) =>
  ({ bookId, title: 't', author: null, coverPath: null, language: 'en', totalChapters: 1, cachedChapters: 1, totalWordCount: 1, isPdf: false, cachedAt: 1, fileId })

describe('offlineDb on V2 (real SQLite)', () => {
  beforeEach(() => oldInstall())

  it('getDb_OldInstallTwoColdStarts_AddsFileIdOnceAndKeepsLegacyRows', async () => {
    let m = await coldStart()
    expect(await m.getCachedUserChapter('legacy-b', 's1')).toMatchObject({ html: '<p>old</p>' })
    m = await coldStart()
    expect(await m.getCachedUserBookMeta('legacy-b')).toMatchObject({ title: 'Old', fileId: null })
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('user_chapters').filter((c) => c === 'file_id')).toHaveLength(1)
    expect(cols('cached_user_books').filter((c) => c === 'file_id')).toHaveLength(1)
  })

  it('dropReplacedUserBookFiles_OtherVersionsOnly_KeepsCurrentLegacyAndOtherBooks', async () => {
    const m = await coldStart()
    await m.cacheUserChapter('b1', ch('old', 'f-old'), 1)
    await m.cacheUserChapter('b1', ch('cur', 'f-cur'), 1)
    await m.cacheUserChapter('b1', ch('leg', null), 1)
    await m.cacheUserChapter('b2', ch('old', 'f-old'), 1)
    await m.cacheUserChapter('b3', ch('x', 'f-x'), 1) // not in this pull (removed book): untouched
    await m.setCachedUserBookMeta(meta('b1', 'f-old'))
    await m.setCachedUserBookMeta(meta('b2', 'f-old'))

    expect(await m.dropReplacedUserBookFiles([{ bookId: 'b1', fileId: 'f-cur' }, { bookId: 'b2', fileId: 'f-old' }])).toEqual(['b1'])
    expect((await m.listCachedUserChapters('b1')).map((c) => c.chapterSlug).sort()).toEqual(['cur', 'leg'])
    expect(await m.getCachedUserBookMeta('b1')).toBeNull()
    expect(await m.listCachedUserChapters('b2')).toHaveLength(1)
    expect(await m.getCachedUserBookMeta('b2')).not.toBeNull()
    expect(await m.listCachedUserChapters('b3')).toHaveLength(1)
    // Nothing left to drop: false, so the caller keeps the downloaded original.
    expect(await m.dropReplacedUserBookFiles([{ bookId: 'b1', fileId: 'f-cur' }])).toEqual([])
  })

  it('refreshCachedUserChapter_LegacyRefreshWithoutFileId_KeepsStoredFileId', async () => {
    const m = await coldStart()
    await m.cacheUserChapter('b1', ch('s', 'f1'), 1)
    await m.refreshCachedUserChapter('b1', ch('s', null))
    expect(db.prepare("SELECT file_id FROM user_chapters WHERE book_id='b1'").get()).toEqual({ file_id: 'f1' })
  })

  it('rekeyCachedUserBooks_GuestIds_MovesBookAndFileIds', async () => {
    const m = await coldStart()
    await m.cacheUserChapter('guest-b', ch('s1', 'guest-f'), 1)
    await m.setCachedUserBookMeta(meta('guest-b', 'guest-f'))
    await m.rekeyCachedUserBooks({ 'guest-b': 'acct-b' }, { 'guest-f': 'acct-f' })
    expect(await m.listCachedUserChapters('guest-b')).toHaveLength(0)
    expect(db.prepare("SELECT book_id, file_id FROM user_chapters WHERE book_id='acct-b'").get()).toEqual({ book_id: 'acct-b', file_id: 'acct-f' })
    expect(await m.getCachedUserBookMeta('acct-b')).toMatchObject({ fileId: 'acct-f' })
  })

  it('rekeyCachedUserBooks_UnknownIds_NoOp', async () => {
    const m = await coldStart()
    await m.cacheUserChapter('b1', ch('s1', 'f1'), 1)
    await m.rekeyCachedUserBooks({ nope: 'x' }, { nope: 'y' })
    expect(db.prepare('SELECT book_id, file_id FROM user_chapters WHERE book_id <> \'legacy-b\'').all()).toEqual([{ book_id: 'b1', file_id: 'f1' }])
  })

  // The account already has a row under the target key on this device (it read the same book
  // before as that account): the account's row wins, and no other book is held back.
  it('rekeyCachedUserBooks_TargetKeyAlreadyCached_AccountRowWinsOthersMove', async () => {
    const m = await coldStart()
    await m.cacheUserChapter('guest-b', ch('s1', 'guest-f'), 1)
    await m.cacheUserChapter('guest-b', ch('s2', 'guest-f'), 1)
    await m.cacheUserChapter('acct-b', ch('s1', 'acct-f'), 1)
    await m.setCachedUserBookMeta(meta('guest-b', 'guest-f'))
    await m.setCachedUserBookMeta(meta('acct-b', 'acct-f'))
    await m.cacheUserChapter('guest-c', ch('s1', 'guest-g'), 1)
    await m.rekeyCachedUserBooks({ 'guest-b': 'acct-b', 'guest-c': 'acct-c' }, { 'guest-f': 'acct-f', 'guest-g': 'acct-g' })
    const rows = db.prepare("SELECT book_id, chapter_slug, html FROM user_chapters WHERE book_id <> 'legacy-b' ORDER BY book_id, chapter_slug").all()
    expect(rows).toEqual([
      { book_id: 'acct-b', chapter_slug: 's1', html: '<p>s1</p>' },
      { book_id: 'acct-b', chapter_slug: 's2', html: '<p>s2</p>' },
      { book_id: 'acct-c', chapter_slug: 's1', html: '<p>s1</p>' },
    ])
    expect(db.prepare("SELECT count(*) AS n FROM cached_user_books WHERE book_id IN ('guest-b', 'acct-b')").get()).toEqual({ n: 1 })
  })
})
