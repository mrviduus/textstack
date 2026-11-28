/**
 * Reading sessions on the device (#1313): kept in the local library by the book's bytes, sent by the outbox to
 * `PUT /me/v2/reading/sessions/{id}`, against the fake V2 API on a real SQLite. PDD "Reading session".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initApi } from '@textstack/shared'
import { resetSyncForTests } from './syncClient'
import { CHANGES_NOT_SYNCED, MAX_FAILURES, createLocalLibrary, type LocalLibrary } from './localLibrary'
import { memoryDb } from './sqliteShim'
import { syncLibrary, type SyncHost } from './librarySync'
import { fakeApi as fakeV2, feed, type Answer, type Call } from '../../../../../packages/shared/src/api/__tests__/fakeSyncApi'


const V2 = 'http://api/me/v2'
const SHA = 'ab'.repeat(32)
const SESSION = { startedAt: '2026-11-14T10:00:00.000Z', endedAt: '2026-11-14T10:05:00.000Z', durationSeconds: 300, wordsRead: 1200, startPercent: 0.1, endPercent: 0.12 }

let n = 0
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const serverBook = (id: string, fileId: string) => ({
  id, title: 'T', author: null, tags: [], hasCover: false, revision: 1, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', removedAt: null,
  currentFile: { id: fileId, sha256: SHA, byteSize: 10, originalName: 'b.epub', format: 'epub', hasContent: false, contentRemovedAt: null, isCurrent: true },
})
const ok = (body: unknown, status = 200): Answer => ({ status, body })
const refused = (status: number, code: string): Answer => ({ status, body: { code, message: code } })
const fakeApi = (routes: Record<string, Answer[]>) => fakeV2({
  'GET /status': [ok({ maxPartBytes: 1024 })], 'GET /library/changes': feed(), 'GET /reading/changes': feed(), 'GET /annotations/changes': feed(), ...routes,
}, V2)
const sessionWrites = (calls: Call[]) => calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/reading/sessions/'))
const host = (): SyncHost => ({ userId: 'u1', newId, reader: () => null, guest: false })
const sessionRows = (lib: LocalLibrary, id: string) => lib.session(id)

/** A book opened here; `pushed`: the server holds it (nothing queued). */
async function library(pushed: boolean) {
  const lib = createLocalLibrary(memoryDb())
  await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
  const bookId = (await lib.localBookId(SHA))!
  const fileId = (await lib.book(bookId))!.file_id!
  if (pushed) {
    fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)] })
    expect(await syncLibrary(lib, host())).toBe('done')
    expect(await lib.outbox()).toEqual([])
  }
  return { lib, bookId, fileId }
}

describe('reading sessions on the device (#1313)', () => {
  beforeEach(() => {
    resetSyncForTests()
    n = 0
    initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('addSession_ThenSync_OnePutUnderItsIdWithTheBooksId_ThenTheRowAndEntryAreGone', async () => {
    const { lib, bookId } = await library(true)
    expect(await lib.addSession(SHA, { ...SESSION, book: SHA } as typeof SESSION, newId)).toBe(true)
    const [entry] = await lib.outbox()
    expect(entry).toMatchObject({ kind: 'session' })
    const path = `/reading/sessions/${entry.target}`
    const calls = fakeApi({ [`PUT ${path}`]: [ok({ clientSessionId: entry.target, ...SESSION, bookId }, 201)] })
    expect(await syncLibrary(lib, host())).toBe('done')
    expect(sessionWrites(calls)).toEqual([{ method: 'PUT', path, body: { bookId, ...SESSION } }])
    expect(await lib.outbox()).toEqual([])
    expect(await sessionRows(lib, entry.target)).toBeNull()
  })

  it('addSession_NoBookWithTheseBytes_NothingKept', async () => {
    const { lib } = await library(true)
    expect(await lib.addSession('cd'.repeat(32), SESSION, newId)).toBe(false)
    expect(await lib.outbox()).toEqual([])
  })

  it('sync_BookNotOnTheServerYet_TheBookFirst_ThenTheSessionUnderTheIdTheServerGave', async () => {
    const { lib, bookId, fileId } = await library(false)
    await lib.addSession(SHA, SESSION, newId)
    const [, entry] = await lib.outbox()
    expect(entry).toMatchObject({ kind: 'session' })
    // The server already has these bytes under another id: the local book takes it (adopt by sha256).
    const serverId = '11111111-1111-4111-8111-111111111111'
    const calls = fakeApi({
      [`GET /books/by-sha256/${SHA}`]: [ok(serverBook(serverId, fileId))],
      [`PUT /reading/sessions/${entry.target}`]: [ok({}, 201)],
    })
    expect(await syncLibrary(lib, host())).toBe('done')
    expect(sessionWrites(calls).map((c) => c.body.bookId)).toEqual([serverId])
    expect(bookId).not.toBe(serverId)
    expect(await lib.outbox()).toEqual([])
  })

  it('sync_ItsBookNotPushedThisPass_NotSentBeforeIt', async () => {
    const { lib } = await library(false)
    await lib.addSession(SHA, SESSION, newId)
    const calls = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 500 }] })
    await syncLibrary(lib, host())
    expect(sessionWrites(calls)).toEqual([])
    expect((await lib.outbox()).map((e) => e.kind)).toEqual(['book', 'session'])
  })

  it('sync_Offline_KeptQueued_SentOnTheNextPass', async () => {
    const { lib, bookId } = await library(true)
    await lib.addSession(SHA, SESSION, newId)
    const [entry] = await lib.outbox()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    await syncLibrary(lib, host())
    expect(await lib.outbox()).toEqual([entry])
    expect(await sessionRows(lib, entry.target)).toMatchObject({ book_id: bookId, words_read: 1200 })
    const calls = fakeApi({ [`PUT /reading/sessions/${entry.target}`]: [ok({}, 200)] })
    expect(await syncLibrary(lib, host())).toBe('done')
    expect(sessionWrites(calls)).toHaveLength(1)
    expect(await lib.outbox()).toEqual([])
  })

  it('sync_BookNotFound_KeptAndTheBookAskedForAgain', async () => {
    const { lib, bookId } = await library(true)
    await lib.addSession(SHA, SESSION, newId)
    const [entry] = await lib.outbox()
    fakeApi({ [`PUT /reading/sessions/${entry.target}`]: [refused(404, 'book_not_found')], [`GET /books/by-sha256/${SHA}`]: [{ status: 599 }] })
    expect(await syncLibrary(lib, host())).toBe('failed')
    expect((await lib.outbox()).map((e) => [e.kind, e.target])).toEqual([['book', bookId], ['session', entry.target]])
    expect(await sessionRows(lib, entry.target)).not.toBeNull()
  })

  it('sync_FailingEveryPass_StopsBeingRetriedAndItsBookSaysNotSynced', async () => {
    const { lib } = await library(true)
    await lib.addSession(SHA, SESSION, newId)
    const [entry] = await lib.outbox()
    const calls = fakeApi({ [`PUT /reading/sessions/${entry.target}`]: [{ status: 500 }] })
    for (let i = 0; i < MAX_FAILURES + 1; i++) await syncLibrary(lib, host())
    expect(sessionWrites(calls)).toHaveLength(MAX_FAILURES)
    expect((await lib.books()).map((b) => b.notSynced)).toEqual([CHANGES_NOT_SYNCED])
  })

  it('sync_InvalidPayload_DroppedWithItsRow', async () => {
    const { lib } = await library(true)
    await lib.addSession(SHA, SESSION, newId)
    const [entry] = await lib.outbox()
    fakeApi({ [`PUT /reading/sessions/${entry.target}`]: [refused(400, 'invalid_payload')] })
    expect(await syncLibrary(lib, host())).toBe('done')
    expect(await lib.outbox()).toEqual([])
    expect(await sessionRows(lib, entry.target)).toBeNull()
  })

  it('signOutLoss_AnUnsentSessionCounts_WipeTakesIt', async () => {
    const { lib, bookId } = await library(true)
    // The server holds the book's bytes: only the unsent session would be lost.
    await lib.setHasContent(bookId)
    expect(await lib.signOutLoss()).toEqual({ books: 0, writes: 0 })
    await lib.addSession(SHA, SESSION, newId)
    const [entry] = await lib.outbox()
    expect(await lib.signOutLoss()).toEqual({ books: 0, writes: 1 })
    await lib.wipe()
    expect(await sessionRows(lib, entry.target)).toBeNull()
  })

  it('adoptAccount_GuestBookReKeyed_TheSessionNamesTheAccountsBook', async () => {
    const { lib, bookId } = await library(true)
    await lib.setAccount('g1', true)
    await lib.addSession(SHA, SESSION, newId)
    const [entry] = await lib.outbox()
    expect(await lib.adoptAccount('g1', { [bookId]: 'acc-book' }, {}, 'acc')).toBe(true)
    expect(await sessionRows(lib, entry.target)).toMatchObject({ book_id: 'acc-book' })
  })
})
