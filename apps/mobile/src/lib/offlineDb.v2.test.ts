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
    // expo-sqlite's own shape: BEGIN inside the try, so a nested BEGIN's ROLLBACK ends the open transaction.
    withTransactionAsync: async (fn: () => Promise<void>) => {
      try { d.exec('BEGIN'); await fn(); d.exec('COMMIT') } catch (e) { d.exec('ROLLBACK'); throw e }
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

  // #1140: two transactions on one connection at once — the second's BEGIN failed and its ROLLBACK ended the first.
  it('transactions_Concurrent_RunOneAtATimeAndBothCommit', async () => {
    const m = await coldStart()
    await m.cacheUserChapter('b1', ch('old', 'f-old'), 1)
    await m.cacheUserChapter('guest-b', ch('s1', 'guest-f'), 1)
    await Promise.all([
      m.dropReplacedUserBookFiles([{ bookId: 'b1', fileId: 'f-cur' }]),
      m.dropReplacedUserBookFiles([{ bookId: 'b1', fileId: 'f-cur' }]),
      m.rekeyCachedUserBooks({ 'guest-b': 'acct-b' }, {}),
    ])
    expect(await m.listCachedUserChapters('b1')).toHaveLength(0)
    expect(await m.listCachedUserChapters('acct-b')).toHaveLength(1)
  })

  // #1140: a failed transaction releases the queue; else every later one rejects with its error.
  it('transactions_OneFails_NextStillRuns', async () => {
    const m = await coldStart()
    await m.cacheUserChapter('b1', ch('old', 'f-old'), 1)
    await m.cacheUserChapter('guest-b', ch('s1', 'guest-f'), 1)
    db.exec("CREATE TRIGGER no_delete BEFORE DELETE ON user_chapters BEGIN SELECT RAISE(ABORT, 'boom'); END")
    await expect(m.dropReplacedUserBookFiles([{ bookId: 'b1', fileId: 'f-cur' }])).rejects.toThrow('boom')
    db.exec('DROP TRIGGER no_delete')
    expect(await m.listCachedUserChapters('b1')).toHaveLength(1) // rolled back
    await m.rekeyCachedUserBooks({ 'guest-b': 'acct-b' }, {})
    expect(await m.listCachedUserChapters('acct-b')).toHaveLength(1)
  })

  // #1142: listeners run after COMMIT, so a re-read never sees rows a rollback could still bring back.
  it('onCachedUserBooksChanged_Drop_NotifiesAfterCommit', async () => {
    const m = await coldStart()
    await m.cacheUserChapter('b1', ch('old', 'f-old'), 1)
    let inTx: boolean | null = null
    const off = m.onCachedUserBooksChanged(() => {
      try { db.exec('BEGIN'); db.exec('ROLLBACK'); inTx = false } catch { inTx = true }
    })
    await m.dropReplacedUserBookFiles([{ bookId: 'b1', fileId: 'f-cur' }])
    off()
    expect(inTx).toBe(false)
  })

  // #1142: the download engine hears about rows that changed behind it.
  it('onCachedUserBooksChanged_DropAndRekey_NotifiesAffectedIdsOnly', async () => {
    const m = await coldStart()
    const heard: string[][] = []
    const off = m.onCachedUserBooksChanged((ids) => heard.push(ids))
    await m.cacheUserChapter('b1', ch('old', 'f-old'), 1)
    await m.dropReplacedUserBookFiles([{ bookId: 'b1', fileId: 'f-cur' }])
    await m.dropReplacedUserBookFiles([{ bookId: 'b1', fileId: 'f-cur' }]) // nothing left: silent
    await m.cacheUserChapter('guest-b', ch('s1', 'guest-f'), 1)
    await m.rekeyCachedUserBooks({ 'guest-b': 'acct-b' }, { 'guest-f': 'acct-f' }) // both ids: one lost rows, one gained them
    await m.rekeyCachedUserBooks({}, {}) // no books in the map: silent
    off()
    await m.cacheUserChapter('guest-c', ch('s1', 'guest-g'), 1)
    await m.rekeyCachedUserBooks({ 'guest-c': 'acct-c' }, {})
    expect(heard).toEqual([['b1'], ['guest-b', 'acct-b']])
  })

  // #1140 review: the sign-out wipe queues behind an open transaction, so that one's rollback cannot undo it.
  it('clearCachedUserBooks_DuringAFailingTransaction_StillWipes', async () => {
    const m = await coldStart()
    await m.cacheUserChapter('guest-b', ch('s1', 'guest-f'), 1)
    await m.cacheUserChapter('b2', ch('s1', 'f2'), 1)
    db.exec("CREATE TRIGGER no_update BEFORE UPDATE ON user_chapters BEGIN SELECT RAISE(ABORT, 'boom'); END")
    const failing = m.rekeyCachedUserBooks({ 'guest-b': 'acct-b' }, {})
    const wipe = m.clearCachedUserBooks()
    await expect(failing).rejects.toThrow('boom')
    await wipe
    db.exec('DROP TRIGGER no_update')
    expect(db.prepare('SELECT count(*) AS n FROM user_chapters').get()).toEqual({ n: 0 })
  })

  // A throwing listener never fails the committed drop (the caller still deletes the originals).
  it('onCachedUserBooksChanged_ListenerThrows_DropStillResolves', async () => {
    const m = await coldStart()
    const off = m.onCachedUserBooksChanged(() => { throw new Error('boom') })
    await m.cacheUserChapter('b1', ch('old', 'f-old'), 1)
    await expect(m.dropReplacedUserBookFiles([{ bookId: 'b1', fileId: 'f-cur' }])).resolves.toEqual(['b1'])
    off()
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

  // #1174: a server-deleted book offers "Remove download" for a partial copy too.
  it('hasAnyUserBookCache_MetaOnlyChaptersOnlyNeither', async () => {
    const m = await coldStart()
    await m.setCachedUserBookMeta(meta('meta-only', null))
    await m.cacheUserChapter('chapters-only', ch('s1', null), 1) // read online, never downloaded: no meta row
    expect(await m.getCachedUserBookMeta('chapters-only')).toBeNull()
    expect(await m.hasAnyUserBookCache('meta-only')).toBe(true)
    expect(await m.hasAnyUserBookCache('chapters-only')).toBe(true)
    expect(await m.hasAnyUserBookCache('neither')).toBe(false)
    await m.deleteCachedUserBook('chapters-only')
    expect(await m.hasAnyUserBookCache('chapters-only')).toBe(false)
  })

  // #1193: the list form of hasAnyUserBookCache, with each book's source.
  it('listUserBookCaches_RowsOfEitherTable_EveryBookWithItsSource', async () => {
    const m = await coldStart() // the old install's 'legacy-b': meta + chapter, no file id
    await m.cacheUserChapter('v2-chapters-only', ch('s1', 'f1'), 1)
    await m.setCachedUserBookMeta(meta('v2-meta-only', 'f2'))
    await m.cacheUserChapter('mixed', ch('a', null), 1)
    await m.cacheUserChapter('mixed', ch('b', 'f3'), 1)
    expect(Object.fromEntries(await m.listUserBookCaches())).toEqual({
      'legacy-b': false, 'v2-chapters-only': true, 'v2-meta-only': true, mixed: true,
    })
    for (const id of ['legacy-b', 'v2-chapters-only', 'v2-meta-only', 'mixed']) expect(await m.hasAnyUserBookCache(id)).toBe(true)
  })

  it('userBookRowBytes_ListedBooksOnly_SumsHtmlBytes', async () => {
    const m = await coldStart()
    await m.cacheUserChapter('kept', { ...ch('a', null), html: 'ééé' }, 1) // 6 bytes, 3 characters
    await m.cacheUserChapter('other', ch('a', null), 1)
    expect(await m.userBookRowBytes(['kept'])).toBe(6)
    expect(await m.userBookRowBytes(['kept', 'legacy-b'])).toBe(6 + '<p>old</p>'.length)
    expect(await m.userBookRowBytes([])).toBe(0)
  })
})
