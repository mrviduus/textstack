/**
 * R6's DoD (#1038): the local library's sync client against the fake V2 API, on a real SQLite
 * (node:sqlite). Conflict tests: simultaneous edit, stale revision, reset, file_replaced, offline
 * queue replay (idempotent by client id / revision / own write), sign-out mid-sync (the shared
 * `whileCurrent` epoch guard), plus the pull merges, id re-keying, opt-in file sync and download.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiError, initApi, UploadNotOnServer, type OpenReader } from '@textstack/shared'
import { resetSyncForTests, syncStore, FileUploadError } from './syncClient'
import { CHANGES_NOT_SYNCED, FILE_NOT_UPLOADED, createLocalLibrary, identityStep, ownedLoss, wipeLibrary, type LocalLibrary, type PositionAction } from './localLibrary'
import { memoryDb } from './sqliteShim'
import { createHostStorage } from './hostStorage'
import { adoptLocalAccount, claimLibraryFor, downloadBook, MAX_FAILURES, holdReaderHost, openBookHost, pushBeforeSignOut, removeLocalBook, syncLibrary, tryAgainBook, type SyncHost } from './librarySync'
import {
  fakeApi as fakeV2, card, conflict, feed, resetMidCall, type Answer, type Call,
} from '../../../../../packages/shared/src/api/__tests__/fakeSyncApi'


const V2 = 'http://api/me/v2'
const SHA = 'ab'.repeat(32)
const CFI = 'epubcfi(/6/14!/4/2/1:0)'
const NOW = Date.now()
const pos = { cfi: CFI, quote: 'It was a bright cold day', index: 6, fraction: 0.41, at: NOW - 60_000 }

let n = 0
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const HL = '0b6a2c1e-1111-4222-8333-444455556666'
const highlight = { id: HL, cfi: CFI, index: 6, quote: 'bright', selectedText: 'bright cold', prefix: 'a ', suffix: ' day', color: 'yellow', at: 1 }
const entry = (position: unknown = pos, highlights: unknown[] = [highlight]) =>
  JSON.stringify({ v: 1, book: { sha256: SHA, size: 10, name: 'b.epub' }, position, highlights })

/** The server's view of a book with this device's ids. */
const serverFile = (id: string, extra: object = {}) =>
  ({ id, sha256: SHA, byteSize: 10, originalName: 'b.epub', format: 'epub', hasContent: false, contentRemovedAt: null, isCurrent: true, ...extra })
const serverBook = (id: string, fileId: string, extra: object = {}, file: object = {}) =>
  ({ id, title: 'T', author: null, tags: [], hasCover: false, revision: 1, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', removedAt: null, currentFile: serverFile(fileId, file), ...extra })
const serverState = (bookId: string, fileId: string, revision: number, extra: object = {}) => ({
  bookId, fileId, currentLocator: { version: 1, scheme: 'epub-cfi', value: CFI, quote: 'It was a bright cold day' }, bookFraction: 0.41,
  frontierLocator: null, frontierFraction: null, completedAt: null, clientRecordedAt: new Date(pos.at).toISOString(),
  updatedAt: '2026-11-10T00:00:01Z', revision, resetRevision: null, ...extra,
})
const serverAnnotation = (bookId: string, fileId: string, revision: number, extra: object = {}) => ({
  id: HL, bookId, fileId, selectedText: 'bright cold', noteText: null, color: 'yellow',
  locator: { version: 1, scheme: 'epub-cfi', value: CFI, quote: 'bright', prefix: 'a ', suffix: ' day' },
  createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', deletedAt: null, revision, ...extra,
})

const ok = (body: unknown, status = 200): Answer => ({ status, body })
const EMPTY_FEEDS = { 'GET /library/changes': feed(), 'GET /reading/changes': feed(), 'GET /annotations/changes': feed(), 'GET /vocabulary/changes': feed() }
const fakeApi = (routes: Record<string, Answer[]>) => fakeV2({ 'GET /status': [ok({ maxPartBytes: 1024 })], ...EMPTY_FEEDS, ...routes }, V2)
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)

/** Calls of `clearFiles` given to `claimLibraryFor` / `wipeLibrary` (#1070). */
let cleared = 0

function host(extra: Partial<SyncHost> = {}): SyncHost & { owed: PositionAction[] } {
  const owed: PositionAction[] = []
  return { userId: 'u1', newId, reader: () => null, onPosition: (a) => owed.push(a), guest: false, owed, ...extra }
}

/** A local book with a position and a highlight, never synced. */
async function seeded(): Promise<{ lib: LocalLibrary; bookId: string; fileId: string }> {
  const lib = createLocalLibrary(memoryDb())
  await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
  const bookId = (await lib.localBookId(SHA))!
  await lib.writeEntry(SHA, entry(), newId)
  return { lib, bookId, fileId: (await lib.book(bookId))!.file_id! }
}

/** The same book after one clean pass: the server knows it, its state at revision 1, the highlight at 1. */
async function synced() {
  const s = await seeded()
  fakeApi({
    [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
    [`PUT /books/${s.bookId}`]: [ok(serverBook(s.bookId, s.fileId), 201)],
    [`PUT /books/${s.bookId}/reading-state`]: [ok(serverState(s.bookId, s.fileId, 1))],
    [`PUT /annotations/${HL}`]: [ok(serverAnnotation(s.bookId, s.fileId, 1), 201)],
  })
  expect(await syncLibrary(s.lib, host())).toBe('done')
  return s
}

const restoredEntry = async (lib: LocalLibrary) => JSON.parse((await lib.readEntry(SHA))!)

describe('V2 local library sync (R6)', () => {
  beforeEach(async () => {
    resetSyncForTests()
    n = 0
    cleared = 0
    initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sync_V2Off_DoesNothingAndKeepsTheOutbox', async () => {
    const { lib } = await seeded()
    const calls = fakeV2({ 'GET /status': [{ status: 404 }] }, V2)
    expect(await syncLibrary(lib, host())).toBe('off')
    expect(calls.map((c) => c.path)).toEqual(['/status'])
    expect(await lib.outbox()).toHaveLength(3)
  })

  it('sync_NewLocalBook_ShaFirstThenImportStateAnnotationInOrderWithClientIds', async () => {
    const { lib, bookId, fileId } = await seeded()
    const calls = fakeApi({
      [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
      [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
      [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
      [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
    })
    expect(await syncLibrary(lib, host())).toBe('done')
    expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL}`])
    const [imp, st, an] = calls.filter((c) => c.method === 'PUT')
    expect(imp.body).toEqual({ title: 'T', author: null, file: { id: fileId, sha256: SHA, byteSize: 10, originalName: 'b.epub', format: 'epub' } })
    expect(st.body).toMatchObject({ expectedRevision: null, fileId, bookFraction: 0.41, currentLocator: { scheme: 'epub-cfi', value: CFI, quote: pos.quote } })
    expect(an.body).toMatchObject({ expectedRevision: null, bookId, fileId, selectedText: 'bright cold', color: 'yellow', locator: { value: CFI, quote: 'bright' } })
    expect(await lib.outbox()).toEqual([])
    expect(await lib.state(bookId)).toMatchObject({ revision: 1, revision_file_id: fileId })
    expect(await lib.annotation(HL)).toMatchObject({ revision: 1 })
    // Cursors stored per feed (null from the fake: a full pull again next time).
    expect(calls.filter((c) => c.path.endsWith('/changes')).map((c) => c.path)).toEqual(['/library/changes', '/reading/changes', '/annotations/changes', '/vocabulary/changes'])
  })

  describe('page bookmarks (#1350)', () => {
    const mark = { id: HL, cfi: 'epubcfi(/6/24)', index: 11, quote: 'Two · p. 12', selectedText: 'Two · p. 12', prefix: '', suffix: '', color: 'bookmark', at: 1 }
    async function bookOf(format: string | null) {
      const lib = createLocalLibrary(memoryDb())
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.pdf', format }, newId)
      const bookId = (await lib.localBookId(SHA))!
      await lib.writeEntry(SHA, entry(null, [mark]), newId)
      return { lib, bookId, fileId: (await lib.book(bookId))!.file_id! }
    }

    it('aPdfBookmark_WrittenAsAPdfPageAnnotationOnItsPage', async () => {
      const { lib, bookId, fileId } = await bookOf('pdf')
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId, {}, { format: 'pdf', originalName: 'b.pdf' }), 201)],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1, { color: 'bookmark', selectedText: mark.selectedText, locator: { version: 1, scheme: 'pdf-page', value: { page: 12, rects: [], exact: '' } } }), 201)],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      const an = calls.find((c) => c.method === 'PUT' && c.path === `/annotations/${HL}`)
      expect(an?.body).toMatchObject({ selectedText: 'Two · p. 12', color: 'bookmark', locator: { version: 1, scheme: 'pdf-page', value: { page: 12, rects: [], exact: '' } } })
      expect(await lib.outbox()).toEqual([])
    })

    // A row on a file version this device holds no format for (not its file, not the server's current one).
    async function onAnOldFile(format: 'pdf' | 'epub') {
      const db = memoryDb()
      const lib = createLocalLibrary(db)
      const name = `b.${format}`
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: name, format }, newId)
      const bookId = (await lib.localBookId(SHA))!
      const fileId = (await lib.book(bookId))!.file_id!
      await lib.writeEntry(SHA, entry(null, [mark]), newId)
      db.raw.prepare('UPDATE annotations SET file_id = ? WHERE id = ?').run(OLD_FILE, HL)
      return { lib, bookId, fileId, name }
    }
    const OLD_FILE = 'aaaaaaaa-0000-4000-8000-00000000000f'

    it('aPdfBookmarkOnAFileOfUnknownFormat_NeverGuessedAsEpubCfi_KeptQueued', async () => {
      const { lib, bookId, fileId, name } = await onAnOldFile('pdf')
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId, {}, { format: 'pdf', originalName: name }), 201)],
      })
      await syncLibrary(lib, host())
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`])
      expect((await lib.outbox()).map((o) => o.target)).toContain(HL)
    })

    it('anEpubBookmarkOnAFileOfUnknownFormat_StillWrittenAsEpubCfi', async () => {
      const { lib, bookId, fileId, name } = await onAnOldFile('epub')
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId, {}, { originalName: name }), 201)],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, OLD_FILE, 1, { color: 'bookmark', selectedText: mark.selectedText, locator: { version: 1, scheme: 'epub-cfi', value: mark.cfi, quote: mark.quote } }), 201)],
      })
      await syncLibrary(lib, host())
      const an = calls.find((c) => c.method === 'PUT' && c.path === `/annotations/${HL}`)
      expect(an?.body).toMatchObject({ fileId: OLD_FILE, color: 'bookmark', locator: { scheme: 'epub-cfi', value: mark.cfi, quote: mark.quote } })
    })
  })

  it('sync_NextPositionAfterASync_NamesTheRevisionLastSeen', async () => {
    const { lib, bookId, fileId } = await synced()
    await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 1000 }), newId)
    const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))] })
    await syncLibrary(lib, host())
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ expectedRevision: 1, bookFraction: 0.5 })
    expect(await lib.state(bookId)).toMatchObject({ revision: 2 })
  })

  describe('offline queue replay (idempotent by client id, revision, own write)', () => {
    it('replay_ImportLandedButAnswerLost_ShaLookupAdoptsNoSecondImport', async () => {
      const { lib, bookId, fileId } = await seeded()
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
      expect(await syncLibrary(lib, host())).toBe('off') // the probe never reached the server
      resetSyncForTests()
      const first = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [{ status: 502 }],
      })
      expect(await syncLibrary(lib, host())).toBe('failed')
      expect(writes(first)).toEqual([`PUT /books/${bookId}`])
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['book', 'state', 'annotation'])
      // The import had landed: the replay finds the bytes and takes the server's (same) ids.
      const second = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [ok(serverBook(bookId, fileId))],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1))],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(second)).toEqual([`PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL}`])
      expect(await lib.outbox()).toEqual([])
    })

    it('replay_StateAndAnnotationLandedAnswersLost_OwnWritesAdoptedNoDuplicate', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.6, at: NOW - 500 }, [{ ...highlight, color: 'green' }]), newId)
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: [{ status: 503, body: { code: 'v2_unavailable', message: 'paused' } }] })
      expect(await syncLibrary(lib, host())).toBe('failed')
      // Both writes had landed (revision 2): the replay is told stale_revision with its own row as current.
      const sentState = { ...serverState(bookId, fileId, 2), bookFraction: 0.6, clientRecordedAt: new Date(NOW - 500).toISOString() }
      const calls = fakeApi({
        [`PUT /books/${bookId}/reading-state`]: [conflict('stale_revision', { revision: 2, current: sentState })],
        [`PUT /annotations/${HL}`]: [conflict('stale_revision', { revision: 2, current: serverAnnotation(bookId, fileId, 2, { color: 'green' }) })],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL}`])
      expect(await lib.state(bookId)).toMatchObject({ revision: 2 })
      expect(await lib.annotation(HL)).toMatchObject({ revision: 2 })
      expect(await lib.outbox()).toEqual([])
    })

    it('replay_SaveLandsWhilePushInFlight_StaysQueuedForTheNextPass', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.6, at: NOW - 500 }), newId)
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        const path = url.replace(V2, '').split('?')[0]
        if (path === '/status') return { ok: true, status: 200, text: async () => JSON.stringify({ maxPartBytes: 1024 }) }
        if (path.endsWith('/changes')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [], cursor: null, hasMore: false }) }
        if (init.method === 'PUT') await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.7, at: NOW - 100 }), newId) // the reader moved on
        return { ok: true, status: 200, text: async () => JSON.stringify(serverState(bookId, fileId, 2)) }
      }))
      await syncLibrary(lib, host())
      expect((await lib.outbox()).map((o) => `${o.kind}:${o.gen}`)).toEqual(['state:2'])
    })
  })

  describe('book push conflicts (the outbox re-read after a re-key)', () => {
    it('duplicateFile_SameBytesUnderAnotherBook_ReKeyedChildrenPushedToItSamePass', async () => {
      const { lib, bookId } = await seeded()
      const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
      const sfid = 'aaaaaaaa-0000-4000-8000-000000000002'
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [conflict('duplicate_file', { current: serverBook(sid, sfid) })],
        [`PUT /books/${sid}/reading-state`]: [ok(serverState(sid, sfid, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(sid, sfid, 1), 201)],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${sid}/reading-state`, `PUT /annotations/${HL}`])
      expect(calls.find((c) => c.path.endsWith('/reading-state'))?.body.fileId).toBe(sfid)
      expect(await lib.book(bookId)).toBeNull()
      expect(await lib.outbox()).toEqual([])
    })

    it('idConflict_BookIdTaken_NewIdsMintedAndImportedSamePass', async () => {
      const { lib, bookId } = await seeded()
      const [nid, nfid] = ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004'] // newId()'s next two
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [conflict('id_conflict')],
        [`PUT /books/${nid}`]: [ok(serverBook(nid, nfid), 201)],
        [`PUT /books/${nid}/reading-state`]: [ok(serverState(nid, nfid, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(nid, nfid, 1), 201)],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${nid}`, `PUT /books/${nid}/reading-state`, `PUT /annotations/${HL}`])
      expect(calls.find((c) => c.path === `/books/${nid}`)?.body.file.id).toBe(nfid)
      expect(await lib.outbox()).toEqual([])
    })

    // QA #1038: an un-coded failure of one entry (a 500 from a CHECK the validation missed) used to
    // end the pass, and the fixed outbox order starved every later entry. Each entry is now isolated.
    it('push_OnePoisonedBookEntry_LaterEntriesStillPushed', async () => {
      const { lib, bookId } = await seeded()
      const SHA2 = 'cd'.repeat(32)
      await lib.addOpened({ sha256: SHA2, size: 10, title: 'U', author: '', originalName: 'u.epub', format: 'epub' }, newId)
      const other = (await lib.localBookId(SHA2))!
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`GET /books/by-sha256/${SHA2}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [{ status: 500 }],
        [`PUT /books/${other}`]: [ok(serverBook(other, (await lib.book(other))!.file_id!, {}, { sha256: SHA2 }), 201)],
      })
      for (let i = 0; i < 3; i++) await syncLibrary(lib, host())
      expect(writes(calls)).toContain(`PUT /books/${other}`)
    })
  })

  describe('reading state conflicts (ADR-019 by CFI + spine index)', () => {
    const theirs = (bookId: string, fileId: string, revision: number, at: number, cfi = 'epubcfi(/6/14!/4/2/9:0)') =>
      serverState(bookId, fileId, revision, { currentLocator: { version: 1, scheme: 'epub-cfi', value: cfi, quote: 'theirs' }, bookFraction: 0.55, clientRecordedAt: new Date(at).toISOString() })

    it('staleRevision_TheirsNewerBookNotOpen_AdoptedNoWrite', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 30_000 }), newId)
      const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [conflict('stale_revision', { revision: 4, current: theirs(bookId, fileId, 4, NOW - 1000) })] })
      const h = host()
      await syncLibrary(lib, h)
      expect(writes(calls)).toEqual([`PUT /books/${bookId}/reading-state`])
      expect((await restoredEntry(lib)).position).toMatchObject({ quote: 'theirs', fraction: 0.55 })
      expect(await lib.state(bookId)).toMatchObject({ revision: 4 })
      expect(h.owed).toEqual([expect.objectContaining({ sha256: SHA, action: 'adopt' })])
      expect(await lib.outbox()).toEqual([])
    })

    it('staleRevision_TheirsNewerReaderMoved_PromptAndOursWrittenOnTheirRevision', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 30_000 }), newId)
      const calls = fakeApi({
        [`PUT /books/${bookId}/reading-state`]: [
          conflict('stale_revision', { revision: 4, current: theirs(bookId, fileId, 4, NOW - 1000) }),
          ok(serverState(bookId, fileId, 5)),
        ],
      })
      const reader: OpenReader = { restoreApplied: true, moved: true, index: 6 }
      const h = host({ reader: (sha) => (sha === SHA ? reader : null) })
      await syncLibrary(lib, h)
      const puts = calls.filter((c) => c.method === 'PUT')
      expect(puts.map((c) => c.body.expectedRevision)).toEqual([1, 4])
      expect(puts[1].body.bookFraction).toBe(0.5) // never yank a reader who moved
      expect(h.owed).toEqual([expect.objectContaining({ action: 'prompt', position: expect.objectContaining({ quote: 'theirs' }) })])
      expect(await lib.state(bookId)).toMatchObject({ revision: 5 })
    })

    it('pull_TheirsNewerRestoredNotMovedSameSpine_MovedSilently', async () => {
      const { lib, bookId, fileId } = await synced()
      fakeApi({ 'GET /reading/changes': feed(theirs(bookId, fileId, 3, NOW - 1000)) })
      const h = host({ reader: () => ({ restoreApplied: true, moved: false, index: 6 }) })
      await syncLibrary(lib, h)
      expect(h.owed.map((o) => o.action)).toEqual(['move'])
      expect((await restoredEntry(lib)).position.quote).toBe('theirs')
    })

    it('pull_TheirsNewerInAnotherSpineItem_PromptNotMoved', async () => {
      const { lib, bookId, fileId } = await synced()
      fakeApi({ 'GET /reading/changes': feed(theirs(bookId, fileId, 3, NOW - 1000, 'epubcfi(/6/20!/4/2/1:0)')) })
      const h = host({ reader: () => ({ restoreApplied: true, moved: false, index: 6 }) })
      await syncLibrary(lib, h)
      expect(h.owed.map((o) => o.action)).toEqual(['prompt'])
      expect((await restoredEntry(lib)).position.quote).toBe(pos.quote)
      expect(await lib.state(bookId)).toMatchObject({ revision: 3 })
    })

    it('staleRevision_OursNewer_OursRewrittenOnTheirRevision', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const calls = fakeApi({
        [`PUT /books/${bookId}/reading-state`]: [conflict('stale_revision', { revision: 7, current: theirs(bookId, fileId, 7, NOW - 50_000) }), ok(serverState(bookId, fileId, 8))],
      })
      await syncLibrary(lib, host())
      expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.body.expectedRevision, c.body.bookFraction])).toEqual([[1, 0.5], [7, 0.5]])
      expect(await lib.state(bookId)).toMatchObject({ revision: 8 })
    })

    it('reset_RestartedElsewhere_PositionWrittenAgainOnTheNewRevision', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const calls = fakeApi({
        [`PUT /books/${bookId}/reading-state`]: [conflict('reset', { revision: 9, current: serverState(bookId, fileId, 9, { resetRevision: 9 }) }), ok(serverState(bookId, fileId, 10))],
      })
      await syncLibrary(lib, host())
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.expectedRevision)).toEqual([1, 9])
      expect(await lib.outbox()).toEqual([])
    })

    it('fileReplaced_ReplacedOnAnotherDevice_WriteDroppedOldCopyKeepsReading', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const replacement = serverFile('7c1e0000-0000-4000-8000-000000000001', { sha256: 'cd'.repeat(32), hasContent: true })
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: [conflict('file_replaced', { fileId: replacement.id, current: null, currentFile: replacement })] })
      await syncLibrary(lib, host())
      expect(await lib.outbox()).toEqual([])
      expect(await lib.book(bookId)).toMatchObject({ file_id: fileId, server_file_id: replacement.id, has_content: 1 })
      expect((await restoredEntry(lib)).position.fraction).toBe(0.5)
      // The next save on the old copy is never sent.
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.6, at: NOW - 50 }), newId)
      const calls = fakeApi({})
      await syncLibrary(lib, host())
      expect(writes(calls)).toEqual([])
    })

    it('staleRevision_NoCurrentRow_RewrittenAsAFirstWrite', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const calls = fakeApi({
        [`PUT /books/${bookId}/reading-state`]: [conflict('stale_revision', { revision: 7, current: null }), ok(serverState(bookId, fileId, 8))],
      })
      await syncLibrary(lib, host())
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.expectedRevision)).toEqual([1, null])
      expect(await lib.state(bookId)).toMatchObject({ revision: 8 })
      expect(await lib.outbox()).toEqual([])
    })

    it('unknownFile_ServerLostTheBook_BookPushedFirstStateKept', async () => {
      const { lib, bookId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: [conflict('unknown_file')] })
      await syncLibrary(lib, host())
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['book', 'state'])
    })

    describe('a transitional textstack-* state (restored by bookFraction, #1187)', () => {
      const transitional = (bookId: string, fileId: string, revision: number, at: number) =>
        serverState(bookId, fileId, revision, { currentLocator: { version: 1, scheme: 'textstack-position-v1', value: { chapterSlug: 'c' } }, bookFraction: 0.7, clientRecordedAt: new Date(at).toISOString() })

      it('pull_TransitionalNewerBookNotOpen_FractionPositionRestoredNoWrite', async () => {
        const { lib, bookId, fileId } = await synced()
        const at = NOW - 1000
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, at)) })
        const h = host()
        await syncLibrary(lib, h)
        const restored = (await restoredEntry(lib)).position
        expect(restored).toEqual({ fraction: 0.7, at })
        expect(h.owed).toEqual([expect.objectContaining({ action: 'adopt', position: { fraction: 0.7, at } })])
        // The page opens the book and restores it with no movement: it sends back what it was given.
        await lib.writeEntry(SHA, entry(restored), newId)
        expect(await lib.outbox()).toEqual([])
        // The next pass (the same revision echoed) owes nothing and writes nothing.
        const calls = fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, at)) })
        const again = host({ reader: () => ({ restoreApplied: true, moved: false, index: 1 }) })
        await syncLibrary(lib, again)
        expect(writes(calls)).toEqual([])
        expect(again.owed).toEqual([])
      })

      it('pull_NewerStateWhileUnmovedOnAFractionLanding_PromptedNoWrite', async () => {
        // Landed by fraction at rev 3, not moved since: rev 4 from another device is offered, never a silent move
        // (#1187 round 3: the host's moved flag is not guard enough). The landing stays here.
        const { lib, bookId, fileId } = await synced()
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, NOW - 2000)) })
        await syncLibrary(lib, host())
        await lib.writeEntry(SHA, entry((await restoredEntry(lib)).position), newId)
        const calls = fakeApi({ 'GET /reading/changes': feed({ ...transitional(bookId, fileId, 4, NOW - 1000), bookFraction: 0.8 }) })
        const h = host({ reader: () => ({ restoreApplied: true, moved: false, index: 1 }) })
        await syncLibrary(lib, h)
        expect(h.owed).toEqual([expect.objectContaining({ action: 'prompt', position: { fraction: 0.8, at: NOW - 1000 } })])
        expect((await restoredEntry(lib)).position).toEqual({ fraction: 0.7, at: NOW - 2000 })
        expect(await lib.state(bookId)).toMatchObject({ revision: 4 })
        expect(writes(calls)).toEqual([])
        expect(await lib.outbox()).toEqual([])
      })

      it('pull_TransitionalNewerReaderRestored_PromptLocalCfiKept', async () => {
        const { lib, bookId, fileId } = await synced()
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, NOW - 1000)) })
        const h = host({ reader: () => ({ restoreApplied: true, moved: false, index: 6 }) })
        await syncLibrary(lib, h)
        expect(h.owed.map((o) => o.action)).toEqual(['prompt'])
        expect((await restoredEntry(lib)).position).toMatchObject({ cfi: CFI, quote: pos.quote })
        expect(await lib.state(bookId)).toMatchObject({ revision: 3 })
      })

      it('pull_TransitionalOlderThanLocal_LocalCfiKeptRevisionTaken', async () => {
        const { lib, bookId, fileId } = await synced()
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, pos.at - 1000)) })
        const h = host()
        await syncLibrary(lib, h)
        expect(h.owed).toEqual([])
        expect((await restoredEntry(lib)).position).toMatchObject({ cfi: CFI })
        expect(await lib.state(bookId)).toMatchObject({ revision: 3 })
      })

      it('fractionOffer_PromptThenTaken_LandedCfiPushedOnTheCurrentRevision', async () => {
        // The reader took the offer: the page landed the fraction and saved the place it landed on as a
        // CFI (goTo chosen). That is a move of theirs: pushed on the revision the prompt took.
        const { lib, bookId, fileId } = await synced()
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, NOW - 1000)) })
        const h = host({ reader: () => ({ restoreApplied: true, moved: true, index: 6 }) })
        await syncLibrary(lib, h)
        expect(h.owed.map((o) => o.action)).toEqual(['prompt'])
        const landed = { cfi: 'epubcfi(/6/20!/4/2/1:0)', quote: 'where it landed', index: 9, fraction: 0.7, at: NOW }
        await lib.writeEntry(SHA, entry(landed), newId)
        expect((await lib.outbox()).map((o) => o.kind)).toEqual(['state'])
        const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 4))] })
        await syncLibrary(lib, host())
        expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
          expectedRevision: 3, bookFraction: 0.7, currentLocator: { scheme: 'epub-cfi', value: landed.cfi, quote: landed.quote },
        })
        expect(await lib.outbox()).toEqual([])
      })

      it('fractionPosition_SavedByThePage_NothingQueued_RealMoveThenPushed', async () => {
        // A position positionWrite can only refuse is never queued (#1187 round 2), not queued and dropped.
        const { lib, bookId, fileId } = await synced()
        await lib.writeEntry(SHA, entry({ fraction: 0.7, at: NOW - 2000 }), newId)
        expect(await lib.outbox()).toEqual([])
        expect((await restoredEntry(lib)).position).toEqual({ fraction: 0.7, at: NOW - 2000 })
        const quiet = fakeApi({})
        await syncLibrary(lib, host())
        expect(writes(quiet)).toEqual([])
        await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.72, at: NOW - 1000 }), newId)
        const next = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))] })
        await syncLibrary(lib, host())
        expect(next.find((c) => c.method === 'PUT')?.body).toMatchObject({ expectedRevision: 1, bookFraction: 0.72, currentLocator: { scheme: 'epub-cfi', value: CFI } })
        expect(await lib.outbox()).toEqual([])
      })

      it('pull_TransitionalPromptedOnce_SameRevisionPulledAgain_NoSecondPrompt', async () => {
        const { lib, bookId, fileId } = await synced()
        const reader = () => ({ restoreApplied: true, moved: false, index: 6 })
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, NOW - 1000)) })
        const h = host({ reader })
        await syncLibrary(lib, h)
        expect(h.owed.map((o) => o.action)).toEqual(['prompt'])
        const calls = fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, NOW - 1000)) })
        const again = host({ reader })
        await syncLibrary(lib, again)
        expect(again.owed).toEqual([])
        expect(writes(calls)).toEqual([])
      })

      it('pull_TransitionalForABookNotImported_ImportedLater_RestoredByFractionNothingPushed', async () => {
        const lib = createLocalLibrary(memoryDb())
        const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
        const sfid = 'aaaaaaaa-0000-4000-8000-000000000002'
        const at = NOW - 1000
        fakeApi({ 'GET /library/changes': feed(serverBook(sid, sfid, {}, { hasContent: true })), 'GET /reading/changes': feed(transitional(sid, sfid, 3, at)) })
        const h = host()
        await syncLibrary(lib, h)
        expect(h.owed).toEqual([])
        expect((await restoredEntry(lib)).position).toEqual({ fraction: 0.7, at })
        await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
        expect(await lib.localBookId(SHA)).toBe(sid)
        const restored = (await restoredEntry(lib)).position
        expect(restored).toEqual({ fraction: 0.7, at })
        await lib.writeEntry(SHA, entry(restored, []), newId)
        expect(await lib.outbox()).toEqual([])
        const calls = fakeApi({ 'GET /reading/changes': feed(transitional(sid, sfid, 3, at)) })
        await syncLibrary(lib, host({ reader: () => ({ restoreApplied: true, moved: false, index: 1 }) }))
        expect(writes(calls)).toEqual([])
      })

      it('fractionPosition_MergeMapReKeyThenAnotherAccount_KeptForTheAccountRefusedForAnotherNeverPushed', async () => {
        const { lib, bookId, fileId } = await synced()
        const at = NOW - 1000
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, at)) })
        await syncLibrary(lib, host())
        await adoptLocalAccount('u1', 'acct', { books: { [bookId]: 'acct-book' }, files: { [fileId]: 'acct-file' } }, () => lib)
        expect((await restoredEntry(lib)).position).toEqual({ fraction: 0.7, at })
        expect(await lib.state('acct-book')).toMatchObject({ revision: 3, revision_file_id: 'acct-file' })
        let calls = fakeApi({})
        await syncLibrary(lib, host({ userId: 'acct' }))
        expect(writes(calls)).toEqual([])
        calls = fakeApi({})
        // Another account's pass is refused (#1070 rule D): kept here, never pushed.
        expect(await syncLibrary(lib, host({ userId: 'someone-else' }))).toBe('refused')
        expect((await restoredEntry(lib)).position).toEqual({ fraction: 0.7, at })
        expect(writes(calls).filter((w) => w.endsWith('/reading-state'))).toEqual([])
      })
    })

    describe('a CBZ page (page-name, #1188)', () => {
      const cbzPage = { cfi: 'epubcfi(/6/4)', page: 'Vol 1/p02.jpg', index: 1, fraction: 0.5, at: NOW - 1000 }
      const pageName = { version: 1, scheme: 'page-name', value: { page: 'Vol 1/p02.jpg', index: 1 } }
      async function cbzBook() {
        const lib = createLocalLibrary(memoryDb())
        await lib.addOpened({ sha256: SHA, size: 10, title: 'C', author: '', originalName: 'c.cbz', format: 'cbz' }, newId)
        const bookId = (await lib.localBookId(SHA))!
        return { lib, bookId, fileId: (await lib.book(bookId))!.file_id! }
      }

      it('cbzPosition_Sent_AsPageNameWithEntryNameAndIndex', async () => {
        const { lib, bookId, fileId } = await cbzBook()
        await lib.writeEntry(SHA, entry(cbzPage, []), newId)
        const calls = fakeApi({
          [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId, {}, { format: 'cbz' }), 201)],
          [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1, { currentLocator: pageName, bookFraction: 0.5 }))],
        })
        await syncLibrary(lib, host())
        expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}/reading-state`])
        expect(calls.find((c) => c.path.endsWith('/reading-state'))!.body).toMatchObject({ expectedRevision: null, fileId, currentLocator: pageName, bookFraction: 0.5 })
        expect(await lib.outbox()).toEqual([])
        expect(await lib.state(bookId)).toMatchObject({ revision: 1 })
      })

      it('pull_PageNameNewerBookNotOpen_ImagePositionRestoredNoWriteBack', async () => {
        const { lib, bookId, fileId } = await cbzBook()
        fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId, {}, { format: 'cbz' }), 201)] })
        await syncLibrary(lib, host())
        const at = NOW - 1000
        fakeApi({ 'GET /reading/changes': feed(serverState(bookId, fileId, 3, { currentLocator: pageName, bookFraction: 0.5, clientRecordedAt: new Date(at).toISOString() })) })
        const h = host()
        await syncLibrary(lib, h)
        const restored = (await restoredEntry(lib)).position
        expect(restored).toEqual({ cfi: 'epubcfi(/6/4)', page: 'Vol 1/p02.jpg', index: 1, fraction: 0.5, at })
        expect(h.owed).toEqual([expect.objectContaining({ action: 'adopt' })])
        // The page restores it and sends back what it was given: nothing queued.
        await lib.writeEntry(SHA, entry(restored, []), newId)
        expect(await lib.outbox()).toEqual([])
      })
    })

    // #1196: a pre-paginated EPUB's page is page-name (its spine href); a reflowable EPUB's place stays epub-cfi.
    describe('a pre-paginated EPUB page (page-name, #1196)', () => {
      const fixedPage = { cfi: 'epubcfi(/6/4[p2])', page: 'OEBPS/p2.xhtml', index: 1, fraction: 0.5, at: NOW - 1000 }
      const pageName = { version: 1, scheme: 'page-name', value: { page: 'OEBPS/p2.xhtml', index: 1 } }

      it('fixedLayoutPosition_SentAsPageName', async () => {
        const { lib, bookId, fileId } = await synced()
        await lib.writeEntry(SHA, entry(fixedPage), newId)
        const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2, { currentLocator: pageName, bookFraction: 0.5 }))] })
        await syncLibrary(lib, host())
        expect(calls.find((c) => c.path.endsWith('/reading-state'))!.body).toMatchObject({ fileId, currentLocator: pageName, bookFraction: 0.5 })
      })

      it('pageKeyTheServerRefuses_NotSentAndSaidSoWithoutTheKey', async () => {
        const { lib, bookId } = await synced()
        await lib.writeEntry(SHA, entry({ ...fixedPage, page: 'x'.repeat(600) }), newId)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const calls = fakeApi({})
        await syncLibrary(lib, host())
        expect(calls.some((c) => c.path === `/books/${bookId}/reading-state`)).toBe(false)
        const said = warn.mock.calls.map((c) => String(c[0]))
        warn.mockRestore()
        expect(said).toEqual([expect.stringMatching(/^\[v2 sync\] page position not synced \(epub\): its page key \(600 UTF-16 units\)/)])
        expect(said[0]).not.toContain('xxxx')
      })

      it('reflowablePosition_SentAsEpubCfi', async () => {
        const { lib, bookId, fileId } = await synced()
        await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 1000 }), newId)
        const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))] })
        await syncLibrary(lib, host())
        expect(calls.find((c) => c.path.endsWith('/reading-state'))!.body.currentLocator).toEqual({ version: 1, scheme: 'epub-cfi', value: pos.cfi, quote: pos.quote })
      })
    })
  })

  describe('annotation conflicts', () => {
    it('staleRevision_EditedOnBothDevices_OursReappliedOnceOnTheirRevision', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      const calls = fakeApi({
        [`PUT /annotations/${HL}`]: [conflict('stale_revision', { revision: 3, current: serverAnnotation(bookId, fileId, 3, { color: 'blue' }) }), ok(serverAnnotation(bookId, fileId, 4, { color: 'green' }))],
      })
      await syncLibrary(lib, host())
      expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.body.expectedRevision, c.body.color])).toEqual([[1, 'green'], [3, 'green']])
      expect(await lib.annotation(HL)).toMatchObject({ revision: 4 })
    })

    it('staleRevision_LosesTwice_KeepsTheServers', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      fakeApi({
        [`PUT /annotations/${HL}`]: [
          conflict('stale_revision', { revision: 3, current: serverAnnotation(bookId, fileId, 3, { color: 'blue' }) }),
          conflict('stale_revision', { revision: 5, current: serverAnnotation(bookId, fileId, 5, { color: 'red' }) }),
        ],
      })
      await syncLibrary(lib, host())
      expect((await restoredEntry(lib)).highlights[0].color).toBe('red')
      expect(await lib.outbox()).toEqual([])
    })

    it('deleted_TombstoneOnTheServer_DeletedHereAndNeverRecreated', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      fakeApi({ [`PUT /annotations/${HL}`]: [conflict('deleted', { revision: 4, current: serverAnnotation(bookId, fileId, 4, { deletedAt: '2026-11-10T01:00:00Z' }) })] })
      await syncLibrary(lib, host())
      expect((await restoredEntry(lib)).highlights).toEqual([])
      // The page, still holding it, saves it back (even edited): the tombstone wins.
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'red' }]), newId)
      expect(await lib.outbox()).toEqual([])
      expect(await lib.annotation(HL)).toMatchObject({ highlight: expect.stringContaining('"green"') })
    })

    it('pull_QueuedLocalEdit_NotOverwrittenOursReappliedOnPush', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      const blue = serverAnnotation(bookId, fileId, 3, { color: 'blue' })
      const calls = fakeApi({
        'GET /annotations/changes': feed(blue),
        [`PUT /annotations/${HL}`]: [conflict('stale_revision', { revision: 3, current: blue }), ok(serverAnnotation(bookId, fileId, 4, { color: 'green' }))],
      })
      await syncLibrary(lib, host())
      expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.body.expectedRevision, c.body.color])).toEqual([[1, 'green'], [3, 'green']])
      expect((await restoredEntry(lib)).highlights[0].color).toBe('green')
    })

    it('unknownFile_AnnotationOnABookTheServerLost_BookPushedFirstHighlightKept', async () => {
      const { lib } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      fakeApi({ [`PUT /annotations/${HL}`]: [conflict('unknown_file')] })
      await syncLibrary(lib, host())
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['book', 'annotation'])
    })

    it('pull_TombstoneWithAQueuedEdit_TombstoneWins', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      const calls = fakeApi({ 'GET /annotations/changes': feed(serverAnnotation(bookId, fileId, 4, { deletedAt: '2026-11-10T01:00:00Z' })) })
      await syncLibrary(lib, host())
      expect(writes(calls)).toEqual([])
      expect((await restoredEntry(lib)).highlights).toEqual([])
    })

    it('idConflict_IdTakenByAnotherUser_NewUuidAndRetried', async () => {
      const { lib, bookId, fileId } = await seeded()
      const minted = '00000000-0000-4000-8000-000000000003' // the next id newId() hands out
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [conflict('id_conflict')],
        [`PUT /annotations/${minted}`]: [ok({ ...serverAnnotation(bookId, fileId, 1), id: minted }, 201)],
      })
      await syncLibrary(lib, host())
      expect((await restoredEntry(lib)).highlights.map((h: { id: string }) => h.id)).toEqual([minted])
      expect(writes(calls).filter((w) => w.includes('/annotations/'))).toEqual([`PUT /annotations/${HL}`, `PUT /annotations/${minted}`])
      expect(await lib.annotation(minted)).toMatchObject({ revision: 1 })
      expect(await lib.outbox()).toEqual([])
      // The page still holds the old id and saves it back: the same CFI + text is the re-keyed highlight.
      await lib.writeEntry(SHA, entry(), newId)
      expect(await lib.outbox()).toEqual([])
    })

    it('overCapSelection_StoredBefore1078_NeverReachesTheServer', async () => {
      const { lib } = await synced()
      const long = { id: '0b6a2c1e-1111-4222-8333-444455550000', cfi: CFI, index: 6, quote: 'x'.repeat(4001), color: 'yellow', at: 2 }
      await lib.writeEntry(SHA, entry(pos, [highlight, long]), newId)
      const calls = fakeApi({})
      await syncLibrary(lib, host())
      expect(writes(calls)).toEqual([])
      expect((await restoredEntry(lib)).highlights).toHaveLength(2)
    })

    it('newHighlight_TwinOfOneInAnotherFileVersion_KeptAndQueued', async () => {
      const { lib, bookId } = await synced()
      // Pulled: the same CFI + text, made on an older version of the file (its CFI means nothing in this one).
      const CFI2 = 'epubcfi(/6/16!/4/2/1:0)'
      fakeApi({ 'GET /annotations/changes': feed({
        ...serverAnnotation(bookId, 'old-file', 1), id: '0b6a2c1e-1111-4222-8333-444455559999', selectedText: 'grey dawn',
        locator: { version: 1, scheme: 'epub-cfi', value: CFI2, quote: 'grey' },
      }) })
      await syncLibrary(lib, host())
      const mine = { ...highlight, id: '0b6a2c1e-1111-4222-8333-444455557777', cfi: CFI2, index: 7, quote: 'grey', selectedText: 'grey dawn' }
      await lib.writeEntry(SHA, entry(pos, [highlight, mine]), newId)
      expect((await lib.outbox()).map((o) => o.target)).toContain(mine.id)
      expect(await lib.annotation(mine.id)).toMatchObject({ book_id: bookId })
    })
  })

  describe('the open book after a re-key (#1303)', () => {
    const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
    const sfid = 'aaaaaaaa-0000-4000-8000-000000000002'
    const theirs = (bookId: string, fileId: string, revision: number) => serverState(bookId, fileId, revision, {
      currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/14!/4/2/9:0)', quote: 'theirs' }, clientRecordedAt: new Date(NOW - 1000).toISOString(),
    })
    /** The reader screen's host for the open book SHA (read at open under its first id), as ReaderScreen builds it. */
    const openHost = (open: OpenReader) => {
      const applied: PositionAction[] = []
      const readerAsked: (OpenReader | null)[] = []
      const h = openBookHost(() => SHA, () => open, (a) => applied.push(a))
      return { ...host({ reader: (sha) => { const r = h.reader(sha); readerAsked.push(r); return r }, onPosition: h.onPosition }), applied, readerAsked }
    }

    it('pull_TwinReKeysTheOpenBookThenANewerPlace_ReaderSeenAndTheMoveApplied', async () => {
      const { lib, bookId } = await seeded()
      fakeApi({
        'GET /library/changes': feed(serverBook(sid, sfid)),
        'GET /reading/changes': feed(theirs(sid, sfid, 3)),
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(sid, sfid, 1), 201)],
      })
      const h = openHost({ restoreApplied: true, moved: false, index: 6 })
      await syncLibrary(lib, h)
      expect(await lib.book(bookId)).toBeNull() // re-keyed during the pass
      expect(await lib.localBookId(SHA)).toBe(sid) // what a word save sends now
      expect(h.readerAsked).toEqual([{ restoreApplied: true, moved: false, index: 6 }])
      expect(h.applied).toEqual([{ sha256: SHA, action: 'move', position: expect.objectContaining({ quote: 'theirs' }) }])
    })

    it('push_ShaLookupReKeysTheOpenBookThenStaleRevision_ReaderSeenAndTheOfferApplied', async () => {
      const { lib, bookId } = await seeded()
      fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [ok(serverBook(sid, sfid))],
        [`PUT /books/${sid}/reading-state`]: [conflict('stale_revision', { revision: 3, current: theirs(sid, sfid, 3) }), ok(serverState(sid, sfid, 4))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(sid, sfid, 1), 201)],
      })
      const h = openHost({ restoreApplied: true, moved: true, index: 6 })
      await syncLibrary(lib, h)
      expect(await lib.book(bookId)).toBeNull()
      expect(h.readerAsked).toEqual([{ restoreApplied: true, moved: true, index: 6 }])
      expect(h.applied).toEqual([{ sha256: SHA, action: 'prompt', position: expect.objectContaining({ quote: 'theirs' }) }])
    })

    it('pull_PassAskedWithoutAReaderWhileOneIsMounted_TheMountedReaderSeenAndTheMoveApplied', async () => {
      const { lib } = await seeded()
      fakeApi({
        'GET /library/changes': feed(serverBook(sid, sfid)),
        'GET /reading/changes': feed(theirs(sid, sfid, 3)),
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(sid, sfid, 1), 201)],
      })
      const mounted = openHost({ restoreApplied: true, moved: false, index: 6 })
      const release = holdReaderHost(mounted)
      try {
        await syncLibrary(lib, host({ onPosition: undefined })) // the app's pass (#1598): no reader of its own
      } finally {
        release()
      }
      expect(mounted.readerAsked).toEqual([{ restoreApplied: true, moved: false, index: 6 }])
      expect(mounted.applied).toEqual([{ sha256: SHA, action: 'move', position: expect.objectContaining({ quote: 'theirs' }) }])
    })

    it('openBookHost_AnotherBookOrNoBytes_NoReaderNothingApplied', () => {
      const applied: PositionAction[] = []
      const h = openBookHost(() => SHA, () => ({ restoreApplied: true, moved: false, index: 1 }), (a) => applied.push(a))
      expect(h.reader('cd'.repeat(32))).toBeNull()
      expect(h.reader(null)).toBeNull()
      h.onPosition({ sha256: 'cd'.repeat(32), action: 'move', position: pos })
      h.onPosition({ sha256: null, action: 'move', position: pos })
      const none = openBookHost(() => null, () => ({ restoreApplied: true, moved: false, index: 1 }), (a) => applied.push(a))
      expect(none.reader(null)).toBeNull()
      none.onPosition({ sha256: null, action: 'move', position: pos })
      expect(applied).toEqual([])
    })
  })

  describe('pull', () => {
    it('pull_SameBytesImportedOnAnotherDevice_LocalBookTakesTheServerIdsNoImport', async () => {
      const { lib, bookId } = await seeded()
      const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
      const sfid = 'aaaaaaaa-0000-4000-8000-000000000002'
      const calls = fakeApi({
        'GET /library/changes': feed(serverBook(sid, sfid)),
        [`PUT /books/${sid}/reading-state`]: [ok(serverState(sid, sfid, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(sid, sfid, 1), 201)],
      })
      await syncLibrary(lib, host())
      expect(writes(calls)).toEqual([`PUT /books/${sid}/reading-state`, `PUT /annotations/${HL}`])
      expect(await lib.book(bookId)).toBeNull()
      expect(await lib.book(sid)).toMatchObject({ file_id: sfid, server_file_id: sfid, sha256: SHA })
      expect(calls.find((c) => c.path.endsWith('/reading-state'))?.body.fileId).toBe(sfid)
    })

    it('pull_BookOnlyOnTheServer_ListedForDownload_DownloadMakesItLocalWithItsState', async () => {
      const lib = createLocalLibrary(memoryDb())
      const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
      const sfid = 'aaaaaaaa-0000-4000-8000-000000000002'
      fakeApi({
        'GET /library/changes': feed(serverBook(sid, sfid, {}, { hasContent: true })),
        'GET /reading/changes': feed(serverState(sid, sfid, 3)),
        'GET /annotations/changes': feed(serverAnnotation(sid, sfid, 1)),
      })
      await syncLibrary(lib, host())
      expect(await lib.books()).toEqual([expect.objectContaining({ id: sid, local: false, sha256: SHA })])
      const io = { fetch: vi.fn(async () => 'staging/dl.epub'), retain: vi.fn(async () => {}) }
      expect(await downloadBook(lib, sid, io)).toBe(true)
      expect(io.fetch).toHaveBeenCalledWith(`${V2}/books/${sid}/files/${sfid}/content`, SHA)
      expect(io.retain).toHaveBeenCalledWith('staging/dl.epub', SHA)
      expect(await lib.books()).toEqual([expect.objectContaining({ id: sid, local: true })])
      const back = await restoredEntry(lib)
      expect(back.position).toMatchObject({ cfi: CFI, quote: pos.quote })
      expect(back.highlights.map((h: { id: string }) => h.id)).toEqual([HL])
    })

    it('pull_CursorSavedPerFeed_NextPassResumesFromIt', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /library/changes': [ok({ items: [], cursor: 'c1', hasMore: false })] })
      await syncLibrary(lib, host())
      expect(await lib.cursor('library')).toBe('c1')
      fakeApi({})
      await syncLibrary(lib, host())
      const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u))
      expect(urls.find((u) => u.includes('/library/changes'))).toContain('cursor=c1')
    })

    // QA #1038: the rows and the cursor were two queue jobs, so a page that failed to apply still
    // advanced the cursor and its rows were skipped for good. Now one transaction.
    it('pull_PageFailsToApply_CursorNotAdvanced', async () => {
      const lib = createLocalLibrary(memoryDb())
      const bad = { ...serverBook('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'), title: null } // title NOT NULL
      fakeApi({ 'GET /library/changes': [ok({ items: [bad], cursor: 'c1', hasMore: false })] })
      expect(await syncLibrary(lib, host())).toBe('failed')
      expect(await lib.cursor('library')).toBeNull()
    })

    it('pull_FailingPageConcurrentWithASave_SaveNotRolledBackWithIt', async () => {
      const { lib } = await seeded()
      const bad = { ...serverBook('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', {}, { sha256: 'ef'.repeat(32) }), title: null }
      const [pulled, saved] = await Promise.allSettled([
        lib.applyBooks([bad as never]),
        lib.writeEntry(SHA, entry({ ...pos, fraction: 0.9 }), newId),
      ])
      expect(pulled.status).toBe('rejected')
      expect(saved.status).toBe('fulfilled')
      expect((await restoredEntry(lib)).position.fraction).toBe(0.9)
    })

    it('pull_OwnWriteEchoed_ChangesNothing', async () => {
      const { lib, bookId, fileId } = await synced()
      const h = host({ reader: () => ({ restoreApplied: true, moved: false, index: 6 }) })
      fakeApi({ 'GET /reading/changes': feed(serverState(bookId, fileId, 1)) })
      await syncLibrary(lib, h)
      expect(h.owed).toEqual([])
    })
  })

  // #1271: the reader's saved words, pulled so the marks work offline. Pull-only: nothing is ever pushed from it.
  describe('vocabulary feed', () => {
    const W1 = 'cccccccc-0000-4000-8000-000000000001'
    const W2 = 'cccccccc-0000-4000-8000-000000000002'
    const clear = () => { cleared++ }
    const words = async (lib: LocalLibrary) => (await lib.savedWords()).map((w) => [w.id, w.word, w.language, w.stage, w.translation])

    it('pull_LiveWords_KeptWithStageAndTranslation_NothingPushed', async () => {
      const lib = createLocalLibrary(memoryDb())
      const calls = fakeApi({
        'GET /vocabulary/changes': [ok({ items: [card(W1, { word: 'Quiver', stage: 2, translation: 'сагайдак' }), card(W2, { word: 'vicinity', language: 'de' })], cursor: 'v1', hasMore: false })],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(await words(lib)).toEqual([[W1, 'Quiver', 'en', 2, 'сагайдак'], [W2, 'vicinity', 'de', 0, null]])
      expect(await lib.cursor('vocabulary')).toBe('v1')
      expect(writes(calls)).toEqual([])
      expect(await lib.outbox()).toEqual([])
    })

    it('pull_ANewerRowReplacesTheCopy_ATombstoneRemovesIt_FromTheCursor', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': [ok({ items: [card(W1), card(W2)], cursor: 'v1', hasMore: false })] })
      await syncLibrary(lib, host())
      fakeApi({ 'GET /vocabulary/changes': [ok({ items: [card(W1, { stage: 4, translation: 'x' }), card(W2, { deletedAt: '2026-11-03T00:00:00Z' })], cursor: 'v2', hasMore: false })] })
      await syncLibrary(lib, host())
      expect(await words(lib)).toEqual([[W1, 'quiver', 'en', 4, 'x']])
      const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u))
      expect(urls.find((u) => u.includes('/vocabulary/changes'))).toContain('cursor=v1')
      expect(await lib.cursor('vocabulary')).toBe('v2')
    })

    it('pull_PagedFeed_EveryPageKept', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': [ok({ items: [card(W1)], cursor: 'p1', hasMore: true }), ok({ items: [card(W2)], cursor: 'p2', hasMore: false })] })
      await syncLibrary(lib, host())
      expect((await words(lib)).map((w) => w[0])).toEqual([W1, W2])
      expect(await lib.cursor('vocabulary')).toBe('p2')
    })

    it('pull_PageFailsToApply_NothingKept_CursorNotAdvanced_ThePassNotFailed', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': [ok({ items: [card(W1), card(W2, { word: null })], cursor: 'v1', hasMore: false })] }) // word NOT NULL
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(await words(lib)).toEqual([])
      expect(await lib.cursor('vocabulary')).toBeNull()
    })

    it('pull_Answered500_ThePushesStillSent_ThePassDone_PulledAfterThem', async () => {
      const { lib, bookId, fileId } = await seeded()
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
        'GET /vocabulary/changes': [{ status: 500 }],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL}`])
      expect(await lib.outbox()).toEqual([])
      const order = calls.map((c) => `${c.method} ${c.path}`)
      expect(order.indexOf('GET /vocabulary/changes')).toBeGreaterThan(order.indexOf(`PUT /annotations/${HL}`))
    })

    /** The guard a save carries: `mine` for a library nobody owns yet, `guardNow` its owner now; the session live. */
    const mine = (_lib: LocalLibrary) => ({ user: 'u1', stale: () => false })
    const guardNow = async (_lib: LocalLibrary, stale = () => false, user: string | null = 'u1') => ({ user, stale })
    const otter = { id: W1, word: 'otter', language: 'en', stage: 0, translation: null }

    it('anAnswerAfterTheSignOutsWipe_NoRow_TheLibraryStaysNobodys', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': feed() })
      await syncLibrary(lib, host({ userId: 'u1' }))
      let signedOut = false
      const guard = await guardNow(lib, () => signedOut)
      await wipeLibrary(lib, clear) // signed out while the save was in flight: the session epoch moved
      signedOut = true
      expect(await lib.upsertWord(otter, guard)).toBe(false)
      expect(await words(lib)).toEqual([])
    })

    it('askedByTheAccountWhileTheGuestsLibraryWasAdoptedToIt_RowWritten', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': feed() })
      await syncLibrary(lib, host({ userId: 'g1', guest: true }))
      const guard = await guardNow(lib, () => false, 'acct') // the new account saves while the library is still the guest's
      await adoptLocalAccount('g1', 'acct', { books: {}, files: {} }, () => lib)
      expect(await lib.upsertWord(otter, guard)).toBe(true)
      expect(await words(lib)).toEqual([[W1, 'otter', 'en', 0, null]])
    })

    it('askedOnANobodysLibrary_ThenClaimedByAnotherUser_NoRow', async () => {
      const lib = createLocalLibrary(memoryDb())
      const guard = await guardNow(lib, () => false, 'x1') // nobody's, asked by x1
      await lib.setAccount('y1') // claimed by y1 before the answer
      expect(await lib.upsertWord(otter, guard)).toBe(false)
      expect(await words(lib)).toEqual([])
    })

    it('askedOnANobodysLibrary_ThenClaimedForTheSameUserMidSave_RowKept', async () => {
      const lib = createLocalLibrary(memoryDb())
      const guard = await guardNow(lib, () => false, 'x1')
      await lib.setAccount('x1') // the first pass claims it for the asker mid-save
      expect(await lib.upsertWord(otter, guard)).toBe(true)
      expect(await words(lib)).toEqual([[W1, 'otter', 'en', 0, null]])
    })

    it('anAnswerOfASessionThatEnded_NoRow_EvenOnANobodysLibrary', async () => {
      const lib = createLocalLibrary(memoryDb())
      let ended = false
      const guard = await guardNow(lib, () => ended)
      ended = true // the session changed (the shared epoch), the library still nobody's
      expect(await lib.upsertWord(otter, guard)).toBe(false)
      expect(await words(lib)).toEqual([])
    })

    it('aGuestsAnswerAfterTheAdoption_NoGuestRow', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': feed() })
      await syncLibrary(lib, host({ userId: 'g1', guest: true }))
      const guard = await guardNow(lib, () => false, 'g1') // asked by the guest
      await adoptLocalAccount('g1', 'acct', { books: {}, files: {} }, () => lib)
      expect(await lib.upsertWord({ ...otter, id: 'guest-card' }, guard)).toBe(false)
      expect(await lib.setWordTranslation('guest-card', 'видра', guard)).toBe(false)
      expect(await words(lib)).toEqual([])
    })

    // #1271 review: this device's own saves are rows too (their answer cards), replaced and removed by the pull as any.
    it('ownSave_ItsAnswerCardUpserted_MarkedFromTheRows_ThenAPullReplacesItById', async () => {
      const lib = createLocalLibrary(memoryDb())
      await lib.upsertWord({ id: W1, word: 'otter', language: 'en', stage: 0, translation: null }, mine(lib))
      expect(await words(lib)).toEqual([[W1, 'otter', 'en', 0, null]])
      fakeApi({ 'GET /vocabulary/changes': feed(card(W1, { word: 'otter', stage: 2, translation: 'видра' })) })
      await syncLibrary(lib, host())
      expect(await words(lib)).toEqual([[W1, 'otter', 'en', 2, 'видра']])
    })

    it('ownSave_DeletedElsewhere_TheTombstoneRemovesIt', async () => {
      const lib = createLocalLibrary(memoryDb())
      await lib.upsertWord({ id: W1, word: 'otter', language: 'en', stage: 0, translation: null }, mine(lib))
      fakeApi({ 'GET /vocabulary/changes': feed(card(W1, { deletedAt: '2026-11-03T00:00:00Z' })) })
      await syncLibrary(lib, host())
      expect(await words(lib)).toEqual([])
    })

    it('aTranslationTheServerTook_OnItsRow_NeverOverOne', async () => {
      const lib = createLocalLibrary(memoryDb())
      await lib.upsertWord({ id: W1, word: 'otter', language: 'en', stage: 0, translation: null }, mine(lib))
      await lib.upsertWord({ id: W2, word: 'reed', language: 'en', stage: 0, translation: 'очерет' }, mine(lib))
      await lib.setWordTranslation(W1, 'видра', mine(lib))
      await lib.setWordTranslation(W2, 'інше', mine(lib))
      expect((await words(lib)).map((x) => x[4])).toEqual(['видра', 'очерет'])
    })

    it('guestAdopted_TheGuestsOwnSavesGo_TheAccountsCardsComeWithTheNextPull', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': feed() })
      await syncLibrary(lib, host({ userId: 'g1', guest: true }))
      expect(await lib.upsertWord({ id: 'guest-card', word: 'otter', language: 'en', stage: 0, translation: null }, await guardNow(lib, () => false, 'g1'))).toBe(true)
      expect(await words(lib)).toEqual([['guest-card', 'otter', 'en', 0, null]])
      await adoptLocalAccount('g1', 'acct', { books: {}, files: {} }, () => lib)
      expect(await words(lib)).toEqual([])
      fakeApi({ 'GET /vocabulary/changes': feed(card(W2, { word: 'otter' })) })
      await syncLibrary(lib, host({ userId: 'acct' }))
      expect(await words(lib)).toEqual([[W2, 'otter', 'en', 0, null]])
    })

    it('pull_Answered503_ThePassEnds_AsForAnyPull', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': [{ status: 503 }] })
      expect(await syncLibrary(lib, host())).toBe('failed')
    })

    it('signOutWipe_WordsGo_NothingCountedAsLost', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': feed(card(W1)) })
      await syncLibrary(lib, host())
      expect(await lib.signOutLoss()).toEqual({ books: 0, writes: 0 })
      await wipeLibrary(lib, clear)
      expect(await words(lib)).toEqual([])
      expect(await lib.cursor('vocabulary')).toBeNull()
    })

    it('anotherAccountSignsIn_TheWordsAreWipedWithTheLibrary', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': feed(card(W1)) })
      await syncLibrary(lib, host({ userId: 'u1' }))
      await claimLibraryFor('u2', () => lib, clear)
      expect(await words(lib)).toEqual([])
    })

    it('guestCarriedToTheNextIdentity_TheGuestsWordsGo_PulledAgainFromTheStart', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': [ok({ items: [card(W1)], cursor: 'g', hasMore: false })] })
      await syncLibrary(lib, host({ userId: 'g1', guest: true }))
      fakeApi({ 'GET /vocabulary/changes': feed(card(W2)) })
      await syncLibrary(lib, host({ userId: 'g2', guest: true }))
      expect((await words(lib)).map((w) => w[0])).toEqual([W2])
      const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u))
      expect(urls.find((u) => u.includes('/vocabulary/changes'))).not.toContain('cursor=')
    })

    it('guestToAccountAdoption_TheGuestCopyGoes_TheAccountsCardsPulledFromTheStart', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({ 'GET /vocabulary/changes': [ok({ items: [card(W1)], cursor: 'g', hasMore: false })] })
      await syncLibrary(lib, host({ userId: 'g1', guest: true }))
      await adoptLocalAccount('g1', 'acct', { books: {}, files: {} }, () => lib)
      expect(await words(lib)).toEqual([])
      expect(await lib.cursor('vocabulary')).toBeNull()
      // The merge kept the account's card for the same key under its own id.
      fakeApi({ 'GET /vocabulary/changes': feed(card(W2)) })
      await syncLibrary(lib, host({ userId: 'acct' }))
      expect((await words(lib)).map((w) => w[0])).toEqual([W2])
    })
  })

  describe('PDF positions: pdf-page, never a CFI (#1128 S5)', () => {
    const page = (n: number, at = NOW - 60_000) => ({ page: n, index: n - 1, fraction: n / 10, at })
    const pdfState = (bookId: string, fileId: string, revision: number, n: number, at: number) =>
      serverState(bookId, fileId, revision, { currentLocator: { version: 1, scheme: 'pdf-page', value: { page: n } }, bookFraction: n / 10, clientRecordedAt: new Date(at).toISOString() })
    /** A local PDF with a page position, pushed once: the server knows it, its state at revision 1. */
    async function syncedPdf() {
      const lib = createLocalLibrary(memoryDb())
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.pdf', format: 'pdf' }, newId)
      const bookId = (await lib.localBookId(SHA))!
      await lib.writeEntry(SHA, entry(page(3), []), newId)
      const fileId = (await lib.book(bookId))!.file_id!
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId, {}, { format: 'pdf', originalName: 'b.pdf' }), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(pdfState(bookId, fileId, 1, 3, NOW - 60_000))],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      return { lib, bookId, fileId, calls }
    }

    it('push_LocalPdfMove_PdfPagePushedWithThePageAlone', async () => {
      const { lib, bookId, fileId, calls } = await syncedPdf()
      expect(calls.find((c) => c.path.endsWith('/reading-state'))?.body).toEqual({
        expectedRevision: null, fileId, bookFraction: 0.3, clientRecordedAt: new Date(NOW - 60_000).toISOString(),
        currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 3 } },
      })
      await lib.writeEntry(SHA, entry(page(5, NOW - 1000), []), newId)
      const next = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(pdfState(bookId, fileId, 2, 5, NOW - 1000))] })
      await syncLibrary(lib, host())
      expect(next.find((c) => c.method === 'PUT')?.body).toMatchObject({ expectedRevision: 1, currentLocator: { scheme: 'pdf-page', value: { page: 5 } } })
      expect(await lib.state(bookId)).toMatchObject({ revision: 2 })
      expect(await lib.outbox()).toEqual([])
    })

    it('push_CfiPositionOnAPdf_NeverPushed_Dropped', async () => {
      const { lib, bookId } = await syncedPdf()
      // The page never builds one for a PDF; a stored one (another shape, a bug) must still never reach the server.
      await lib.writeEntry(SHA, entry({ ...pos, at: NOW - 1000 }), newId)
      const calls = fakeApi({})
      await syncLibrary(lib, host())
      expect(writes(calls).filter((w) => w.endsWith('/reading-state'))).toEqual([])
      expect((await lib.outbox()).filter((o) => o.kind === 'state')).toEqual([])
      // QA: only the write is dropped; the local row keeps that position (the page refuses it on restore:
      // "wrong position kind"), and the next page position replaces it.
      expect(JSON.parse((await lib.state(bookId))!.position!)).toMatchObject({ cfi: pos.cfi })
    })

    it('pull_PdfPageState_StoredAndRestoredAsThePage', async () => {
      const { lib, bookId, fileId } = await syncedPdf()
      fakeApi({ 'GET /reading/changes': feed(pdfState(bookId, fileId, 3, 9, NOW - 1000)) })
      const h = host()
      await syncLibrary(lib, h)
      expect((await restoredEntry(lib)).position).toEqual({ page: 9, index: 8, fraction: 0.9, at: NOW - 1000 })
      expect(await lib.state(bookId)).toMatchObject({ revision: 3 })
      expect(h.owed).toEqual([expect.objectContaining({ sha256: SHA, action: 'adopt', position: { page: 9, index: 8, fraction: 0.9, at: NOW - 1000 } })])
    })

    it('pull_PdfPageOnTheOpenPage_MovedSilently_OtherPage_Prompted', async () => {
      const { lib, bookId, fileId } = await syncedPdf()
      fakeApi({ 'GET /reading/changes': feed(pdfState(bookId, fileId, 3, 3, NOW - 1000)) })
      const same = host({ reader: () => ({ restoreApplied: true, moved: false, index: 2 }) })
      await syncLibrary(lib, same)
      expect(same.owed.map((o) => o.action)).toEqual(['move'])
      fakeApi({ 'GET /reading/changes': feed(pdfState(bookId, fileId, 4, 8, NOW - 500)) })
      const other = host({ reader: () => ({ restoreApplied: true, moved: false, index: 2 }) })
      await syncLibrary(lib, other)
      expect(other.owed.map((o) => o.action)).toEqual(['prompt'])
    })

    it('pull_TransitionalStateOnAPdf_NoFractionFallback_PageKept', async () => {
      const { lib, bookId, fileId } = await syncedPdf()
      const transitional = serverState(bookId, fileId, 3, { currentLocator: { version: 1, scheme: 'textstack-position-v1', value: { chapterSlug: 'x', chapterFraction: 0.5 } }, bookFraction: 0.7, clientRecordedAt: new Date(NOW - 1000).toISOString() })
      fakeApi({ 'GET /reading/changes': feed(transitional) })
      const h = host()
      await syncLibrary(lib, h)
      expect((await restoredEntry(lib)).position).toEqual(page(3))
      expect(await lib.state(bookId)).toMatchObject({ revision: 3 })
      expect(h.owed).toEqual([])
    })

    it('pull_PdfOnlyOnTheServer_PageStateKept_TransitionalOneNot', async () => {
      const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
      const sfid = 'aaaaaaaa-0000-4000-8000-000000000002'
      const io = { fetch: vi.fn(async () => 'staging/dl.pdf'), retain: vi.fn(async () => {}) }
      for (const [state, expected] of [
        [pdfState(sid, sfid, 3, 4, NOW - 1000), { page: 4, index: 3, fraction: 0.4, at: NOW - 1000 }],
        [serverState(sid, sfid, 3, { currentLocator: { version: 1, scheme: 'textstack-position-v1', value: { chapterSlug: 'x', chapterFraction: 0.5 } }, bookFraction: 0.7 }), null],
      ] as const) {
        resetSyncForTests()
        const lib = createLocalLibrary(memoryDb())
        fakeApi({
          'GET /library/changes': feed(serverBook(sid, sfid, {}, { hasContent: true, format: 'pdf', originalName: 'b.pdf' })),
          'GET /reading/changes': feed(state),
        })
        await syncLibrary(lib, host())
        expect(await downloadBook(lib, sid, io)).toBe(true)
        expect((await restoredEntry(lib)).position, state.currentLocator.scheme).toEqual(expected)
      }
    })

    it('downloadBook_LocalCopyDamagedAndTheServerHoldsTheSameBytes_FetchedAgainOverIt_IntactCopyNever (#1602)', async () => {
      const lib = createLocalLibrary(memoryDb())
      const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
      const sfid = 'aaaaaaaa-0000-4000-8000-000000000002'
      fakeApi({ 'GET /library/changes': feed(serverBook(sid, sfid, {}, { hasContent: true })) })
      await syncLibrary(lib, host())
      const io = { fetch: vi.fn(async () => 'staging/dl.epub'), retain: vi.fn(async () => {}), intact: vi.fn(() => true) }
      expect(await downloadBook(lib, sid, io)).toBe(true) // on this device now
      expect(await downloadBook(lib, sid, io)).toBe(false) // its copy intact: nothing fetched
      expect(io.fetch).toHaveBeenCalledTimes(1)
      io.intact.mockReturnValue(false) // the copy damaged (0 bytes)
      expect(await downloadBook(lib, sid, io)).toBe(true) // here again
      expect(io.intact).toHaveBeenLastCalledWith(SHA)
      expect(io.fetch).toHaveBeenCalledTimes(2)
      expect(io.retain).toHaveBeenLastCalledWith('staging/dl.epub', SHA)
      expect((await lib.books()).map((b) => [b.id, b.local])).toEqual([[sid, true]]) // still one local row
    })

    it('androidHost_ServerOnlyPdf_DownloadOpenTurn_RestoresPullAndPushesPdfPageOnItsRevision', async () => {
      // R7 (#1039), the dev route's calls in order: pull, download on demand, open (restore, addOpened
      // with the page's `format`), a page turn's `store`, the next pass.
      const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
      const sfid = 'aaaaaaaa-0000-4000-8000-000000000002'
      const lib = createLocalLibrary(memoryDb())
      const files = { read: async () => null, move: async () => {}, exists: () => true, remove: () => {}, copyIn: async () => {} }
      const storage = createHostStorage(files, newId, lib)
      fakeApi({
        'GET /library/changes': feed(serverBook(sid, sfid, {}, { hasContent: true, format: 'pdf', originalName: 'b.pdf' })),
        'GET /reading/changes': feed(pdfState(sid, sfid, 3, 4, NOW - 1000)),
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect((await storage.books()).map((b) => [b.id, b.local])).toEqual([[sid, false]])
      expect(await downloadBook(lib, sid, { fetch: async () => 'staging/dl.epub', retain: async () => {} })).toBe(true)
      // What the host hands `restore`: the other device's page.
      expect(JSON.parse((await storage.readStore(SHA))!).position).toEqual({ page: 4, index: 3, fraction: 0.4, at: NOW - 1000 })
      await storage.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.pdf', format: 'pdf' }, null)
      expect(await storage.bookIdOf(SHA)).toBe(sid)
      await storage.writeStore(SHA, entry(page(7, NOW - 100), []))
      const calls = fakeApi({ [`PUT /books/${sid}/reading-state`]: [ok(pdfState(sid, sfid, 4, 7, NOW - 100))] })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`PUT /books/${sid}/reading-state`])
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        expectedRevision: 3, fileId: sfid, bookFraction: 0.7, clientRecordedAt: new Date(NOW - 100).toISOString(),
        currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 7 } },
      })
      expect(await lib.state(sid)).toMatchObject({ revision: 4, revision_file_id: sfid })
      expect(await lib.outbox()).toEqual([])
    })
  })

  describe('sign-out mid-sync (the shared whileCurrent epoch guard, #1151/#1155)', () => {
    it('signOutDuringImport_NothingOfThatAnswerLands', async () => {
      const { lib, bookId, fileId } = await seeded()
      const result = await resetMidCall(() => syncStore.reset(), {
        'GET /status': ok({ maxPartBytes: 1024 }),
        'GET /library/changes': feed()[0], 'GET /reading/changes': feed()[0], 'GET /annotations/changes': feed()[0], 'GET /vocabulary/changes': feed()[0],
        [`GET /books/by-sha256/${SHA}`]: { status: 404 },
        [`PUT /books/${bookId}`]: ok(serverBook(bookId, fileId), 201),
      }, () => syncLibrary(lib, host()), `/books/${bookId}`)
      expect(result).toBe('dropped')
      expect(await lib.book(bookId)).toMatchObject({ server_file_id: null })
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['book', 'state', 'annotation'])
    })

    it('signOutDuringPull_FeedAndCursorNotKept', async () => {
      const lib = createLocalLibrary(memoryDb())
      const result = await resetMidCall(() => syncStore.reset(), {
        'GET /status': ok({ maxPartBytes: 1024 }),
        'GET /library/changes': { status: 200, body: { items: [serverBook('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', {}, { hasContent: true })], cursor: 'c1', hasMore: false } },
      }, () => syncLibrary(lib, host()), '/library/changes')
      expect(result).toBe('dropped')
      expect(await lib.books()).toEqual([])
      expect(await lib.cursor('library')).toBeNull()
    })

    it('signOutDuringA409_ConflictHandlingWritesNothing', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 30_000 }), newId)
      const result = await resetMidCall(() => syncStore.reset(), {
        'GET /status': ok({ maxPartBytes: 1024 }),
        'GET /library/changes': feed()[0], 'GET /reading/changes': feed()[0], 'GET /annotations/changes': feed()[0], 'GET /vocabulary/changes': feed()[0],
        [`PUT /books/${bookId}/reading-state`]: conflict('stale_revision', { revision: 4, current: serverState(bookId, fileId, 4, { clientRecordedAt: new Date(NOW).toISOString(), bookFraction: 0.9 }) }),
      }, () => syncLibrary(lib, host()), '/reading-state')
      expect(result).toBe('dropped')
      expect(await lib.state(bookId)).toMatchObject({ revision: 1 })
      expect((await restoredEntry(lib)).position.fraction).toBe(0.5)
    })

    const pushRoutes = (bookId: string, fileId: string) => ({
      'GET /status': ok({ maxPartBytes: 1024 }),
      'GET /library/changes': feed()[0], 'GET /reading/changes': feed()[0], 'GET /annotations/changes': feed()[0], 'GET /vocabulary/changes': feed()[0],
      [`PUT /books/${bookId}/reading-state`]: ok(serverState(bookId, fileId, 2)),
      [`PUT /annotations/${HL}`]: ok(serverAnnotation(bookId, fileId, 2, { color: 'green' })),
    })

    it('signOutDuringStatePush_AnswerNotLandedWriteStaysQueued', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const result = await resetMidCall(() => syncStore.reset(), pushRoutes(bookId, fileId), () => syncLibrary(lib, host()), '/reading-state')
      expect(result).toBe('dropped')
      expect(await lib.state(bookId)).toMatchObject({ revision: 1 })
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['state'])
    })

    it('signOutDuringAnnotationPush_AnswerNotLandedWriteStaysQueued', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      const result = await resetMidCall(() => syncStore.reset(), pushRoutes(bookId, fileId), () => syncLibrary(lib, host()), `/annotations/${HL}`)
      expect(result).toBe('dropped')
      expect(await lib.annotation(HL)).toMatchObject({ revision: 1 })
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['annotation'])
    })

    it('signOutWhileAPulledStateApplies_NothingOwedToTheReader', async () => {
      const { lib, bookId, fileId } = await synced()
      const theirs = serverState(bookId, fileId, 3, { currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/14!/4/2/9:0)', quote: 'theirs' }, clientRecordedAt: new Date(NOW - 1000).toISOString() })
      fakeApi({ 'GET /reading/changes': feed(theirs) })
      const h = host({ reader: () => { syncStore.reset(); return { restoreApplied: true, moved: false, index: 6 } } })
      expect(await syncLibrary(lib, h)).toBe('dropped')
      expect(h.owed).toEqual([])
    })

    it('signOutDuringUpload_NoLaterBookSentNothingMarked', async () => {
      const { lib, bookId } = await synced()
      const SHA2 = 'cd'.repeat(32)
      await lib.addOpened({ sha256: SHA2, size: 10, title: 'U', author: '', originalName: 'u.epub', format: 'epub' }, newId)
      const other = (await lib.localBookId(SHA2))!
      const otherFile = (await lib.book(other))!.file_id!
      await lib.setServerFile(other, serverFile(otherFile, { sha256: SHA2 }) as never)
      await lib.done({ kind: 'book', target: other, gen: 1, failures: 0 })
      await lib.setFileSync(true)
      fakeApi({})
      const upload = vi.fn(async () => { syncStore.reset() })
      expect(await syncLibrary(lib, host({ upload }))).toBe('dropped')
      expect(upload).toHaveBeenCalledTimes(1)
      expect(await lib.book(bookId)).toMatchObject({ has_content: 0 })
      expect(await lib.book(other)).toMatchObject({ has_content: 0 })
    })

    it('signOutWhileADownloadIsRetained_BookNotMadeLocal', async () => {
      const lib = createLocalLibrary(memoryDb())
      const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
      fakeApi({ 'GET /library/changes': feed(serverBook(sid, 'aaaaaaaa-0000-4000-8000-000000000002', {}, { hasContent: true })) })
      await syncLibrary(lib, host())
      const io = { fetch: vi.fn(async () => 'staging/dl.epub'), retain: vi.fn(async () => { syncStore.reset() }) }
      expect(await downloadBook(lib, sid, io)).toBe(false)
      expect(await lib.book(sid)).toMatchObject({ imported_at: null })
    })
  })

  describe('accounts (#1070: identity rules)', () => {
    const HL2 = { ...highlight, id: '1b6a2c1e-1111-4222-8333-444455556666', cfi: 'epubcfi(/6/14!/4/2/1:9)', quote: 'cold', selectedText: 'cold day', prefix: 'bright ', suffix: '' }
    /** u1's library (an account) with a position and a second highlight not sent yet. */
    const withUnsent = async () => {
      const s = await synced()
      await s.lib.writeEntry(SHA, entry({ ...pos, fraction: 0.8, at: NOW }, [highlight, HL2]), newId)
      return s
    }
    const warnings = () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      return { lines: () => warn.mock.calls.map((c) => String(c[0])), restore: () => warn.mockRestore() }
    }
    const clear = () => { cleared++ }
    const gated = (lib: LocalLibrary) => {
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      return { release, slow: { ...lib, owner: async () => { await gate; return lib.owner() } } }
    }

    it('identityStep_TheFourRules', () => {
      expect(identityStep(null, 'u1')).toBe('claim')
      expect(identityStep({ id: 'u1', guest: false }, 'u1')).toBe('same')
      expect(identityStep({ id: 'g1', guest: true }, 'u1')).toBe('carry')
      expect(identityStep({ id: 'u1', guest: false }, 'u2')).toBe('foreign')
    })

    it('signOutLoss_BookOnTheServer_QueuedAndNeverSentChangesCountedSyncedNot', async () => {
      const { lib, bookId } = await withUnsent()
      await lib.setHasContent(bookId)
      // The position and HL2 queued; HL (synced, revision 1) is on the server; the book's own entry
      // (asked for again by a child) is no change of the reader's.
      await lib.queueBook(bookId)
      expect(await lib.signOutLoss()).toEqual({ books: 0, writes: 2 })
      // HL2 dropped after a refusal ("kept on the device only"): no entry, still only here.
      const [queued] = await lib.outbox('annotation')
      await lib.done(queued)
      expect(await lib.signOutLoss()).toEqual({ books: 0, writes: 2 })
    })

    // A: an emptied library has no owner.
    it('signOutWipe_OwnerCleared_RowsAfterItTakenByTheFirstIdentityThatSyncs', async () => {
      const { lib } = await withUnsent()
      syncStore.reset() // signed out: the epoch bump, then the wipe
      await wipeLibrary(lib, clear)
      expect(await lib.owner()).toBeNull()
      // A book added with no session (or an open finishing late) belongs to nobody.
      await lib.addOpened({ sha256: 'ef'.repeat(32), size: 3, title: 'Late', author: '', originalName: 'l.epub', format: null }, newId)
      const late = (await lib.localBookId('ef'.repeat(32)))!
      fakeApi({})
      expect(await syncLibrary(lib, host({ userId: 'u2' }))).toBe('done')
      expect(await lib.owner()).toEqual({ id: 'u2', guest: false })
      expect((await lib.books()).map((b) => b.id)).toEqual([late])
      expect(cleared).toBe(1)
    })

    // B: the another-account wipe is sign-in's.
    describe('claimLibraryFor (sign-in)', () => {
      it('claim_AnotherRealAccountsLibrary_WipedLossLogged', async () => {
        const { lib } = await withUnsent()
        const w = warnings()
        await claimLibraryFor('u2', () => lib, clear)
        expect(await lib.books()).toEqual([])
        expect(await lib.outbox()).toEqual([])
        expect(await lib.owner()).toBeNull()
        expect(cleared).toBe(1)
        expect(w.lines().filter((m) => m.includes('another account signed in'))).toEqual([expect.stringContaining('lost 1 book(s) and 0 change(s)')])
        w.restore()
      })

      it('claim_SameAccountGuestOwnedOrUnowned_NothingWiped', async () => {
        const { lib, bookId } = await withUnsent()
        await claimLibraryFor('u1', () => lib, clear)
        await lib.setAccount('g1', true)
        await claimLibraryFor('u2', () => lib, clear)
        expect((await lib.books()).map((b) => b.id)).toEqual([bookId])
        expect(cleared).toBe(0)
        const empty = createLocalLibrary(memoryDb())
        await claimLibraryFor('u2', () => empty, clear)
        expect(cleared).toBe(0)
      })

      // #1611: asked before a sign-in's server call: a real owner's books or changes only on this phone.
      it('ownedLoss_RealOwnersUnsentBook_ReturnsTheLoss', async () => {
        const { lib } = await withUnsent()
        expect(await ownedLoss(lib)).toEqual({ books: 1, writes: 0 })
      })

      it('ownedLoss_NothingLostUnownedOrGuestOwned_ReturnsNull', async () => {
        const { lib } = await withUnsent()
        const synced = createLocalLibrary(memoryDb())
        await synced.setAccount('u1', false)
        expect(await ownedLoss(synced)).toBeNull()
        expect(await ownedLoss(createLocalLibrary(memoryDb()))).toBeNull()
        await lib.setAccount('g1', true)
        expect(await ownedLoss(lib)).toBeNull()
      })

      it('ownedLoss_ReadFails_ReturnsUnknown', async () => {
        const { lib } = await withUnsent()
        expect(await ownedLoss({ ...lib, owner: () => Promise.reject(new Error('disk busy')) })).toBe('unknown')
      })

      it('claim_RowWipeFails_FilesAndOwnerKept_PassesStillRefused', async () => {
        const { lib, bookId } = await withUnsent()
        const broken = { ...lib, wipe: () => Promise.reject(new Error('disk busy')) }
        const w = warnings()
        await expect(claimLibraryFor('u2', () => broken, clear)).rejects.toThrow('disk busy')
        expect(cleared).toBe(0)
        expect(await lib.owner()).toEqual({ id: 'u1', guest: false })
        syncStore.reset()
        const calls = fakeApi({})
        expect(await syncLibrary(lib, host({ userId: 'u2' }))).toBe('refused')
        expect(writes(calls)).toEqual([])
        expect((await lib.books()).map((b) => b.id)).toEqual([bookId])
        w.restore()
      })
    })

    // C: a guest's library carries over.
    describe('guest-owned library', () => {
      /** A guest's synced library (the guest's first pass recorded it as a guest's). */
      async function guestLibrary() {
        const s = await seeded()
        fakeApi({
          [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
          [`PUT /books/${s.bookId}`]: [ok(serverBook(s.bookId, s.fileId), 201)],
          [`PUT /books/${s.bookId}/reading-state`]: [ok(serverState(s.bookId, s.fileId, 1))],
          [`PUT /annotations/${HL}`]: [ok(serverAnnotation(s.bookId, s.fileId, 1), 201)],
        })
        expect(await syncLibrary(s.lib, host({ userId: 'g1', guest: true }))).toBe('done')
        expect(await s.lib.owner()).toEqual({ id: 'g1', guest: true })
        await s.lib.writeEntry(SHA, entry({ ...pos, fraction: 0.8, at: NOW }), newId)
        return s
      }

      it('guestToAccount_AdoptThrows_RowsAsTheyWere_FirstPassCarriesThemToTheAccount', async () => {
        const { lib, bookId } = await guestLibrary()
        const broken = () => ({ ...lib, adoptAccount: () => Promise.reject(new Error('disk busy')) })
        await expect(adoptLocalAccount('g1', 'acct', { books: { [bookId]: 'acct-book' }, files: {} }, broken)).rejects.toThrow('disk busy')
        // A failed adopt leaves the rows as they were (AuthContext's comment).
        expect(await lib.owner()).toEqual({ id: 'g1', guest: true })
        expect((await lib.books()).map((b) => b.id)).toEqual([bookId])
        await claimLibraryFor('acct', () => lib, clear)
        expect(cleared).toBe(0)
        syncStore.reset()
        const calls = fakeApi({
          [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
          [`PUT /books/${bookId}`]: [ok(serverBook(bookId, (await lib.book(bookId))!.file_id!), 201)],
          [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, (await lib.book(bookId))!.file_id!, 1))],
        })
        // Two passes: the state asks for its book first (what the server told the guest is forgotten).
        for (let i = 0; i < 2; i++) await syncLibrary(lib, host({ userId: 'acct' }))
        expect(await lib.owner()).toEqual({ id: 'acct', guest: false })
        // The guest's book and its unsent position go to the account.
        expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}/reading-state`])
        expect((await restoredEntry(lib)).position.fraction).toBe(0.8)
      })

      it('guestToNewGuest_Carried', async () => {
        const { lib, bookId } = await guestLibrary()
        syncStore.reset()
        fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [{ status: 502 }] })
        await syncLibrary(lib, host({ userId: 'g2', guest: true }))
        expect(await lib.owner()).toEqual({ id: 'g2', guest: true })
        expect((await lib.books()).map((b) => b.id)).toEqual([bookId])
      })

      it('guestPromotedInPlace_SameId_RecordedAsAnAccount', async () => {
        const { lib } = await guestLibrary()
        fakeApi({})
        await syncLibrary(lib, host({ userId: 'g1', guest: false }))
        expect(await lib.owner()).toEqual({ id: 'g1', guest: false })
      })

      it('guestSignsIn_MergeMapRekeysTheLibraryCursorsClearedNoWipe', async () => {
        const { lib, bookId, fileId } = await synced()
        await lib.setAccount('u1', true)
        fakeApi({ 'GET /library/changes': [ok({ items: [], cursor: 'c1', hasMore: false })] })
        await syncLibrary(lib, host({ guest: true }))
        expect(await lib.cursor('library')).toBe('c1')
        await claimLibraryFor('acct', () => lib, clear)
        await adoptLocalAccount('u1', 'acct', { books: { [bookId]: 'acct-book' }, files: { [fileId]: 'acct-file' } }, () => lib)
        expect(await lib.owner()).toEqual({ id: 'acct', guest: false })
        expect(await lib.book('acct-book')).toMatchObject({ file_id: 'acct-file', server_file_id: 'acct-file' })
        expect(await lib.state('acct-book')).toMatchObject({ revision: 1, revision_file_id: 'acct-file' })
        expect(await lib.annotation(HL)).toMatchObject({ book_id: 'acct-book', file_id: 'acct-file' })
        expect(await lib.cursor('library')).toBeNull()
        await adoptLocalAccount('someone-else', 'x', undefined, () => lib)
        expect(await lib.account()).toBe('acct')
        fakeApi({})
        await syncLibrary(lib, host({ userId: 'acct' }))
        expect(cleared).toBe(0)
        expect((await lib.books()).map((b) => b.id)).toEqual(['acct-book'])
      })
    })

    // D: a pass never wipes.
    it('passForAnotherRealAccount_Refused_NothingPulledPushedRecordedNoWipeNoLoop', async () => {
      const { lib, bookId } = await withUnsent()
      const w = warnings()
      syncStore.reset() // the session expired (onAuthFailure: no wipe); u2's sign-in wipe did not run
      for (let i = 0; i < 2; i++) {
        const calls = fakeApi({})
        expect(await syncLibrary(lib, host({ userId: 'u2' }))).toBe('refused')
        expect(calls.filter((c) => c.path !== '/status')).toEqual([])
      }
      expect(await lib.owner()).toEqual({ id: 'u1', guest: false })
      expect((await lib.books()).map((b) => b.id)).toEqual([bookId])
      expect((await lib.outbox()).length).toBe(2)
      expect(w.lines().filter((m) => m.includes('pass refused'))).toHaveLength(2)
      w.restore()
    })

    it('sameAccountSignsBackIn_EverythingKeptAndPushed', async () => {
      const { lib, bookId, fileId } = await withUnsent()
      syncStore.reset()
      const calls = fakeApi({
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))],
        [`PUT /annotations/${HL2.id}`]: [ok({ ...serverAnnotation(bookId, fileId, 1), id: HL2.id }, 201)],
      })
      await syncLibrary(lib, host())
      expect(writes(calls)).toEqual([`PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL2.id}`])
    })

    // E: the stale-id race only refuses.
    it('staleUserIdAfterTheOwnerChanged_Refused_LibraryIntact', async () => {
      const { lib, bookId } = await withUnsent()
      await claimLibraryFor('u2', () => lib, clear) // u2 signs in: u1's library wiped
      await lib.addOpened({ sha256: 'ef'.repeat(32), size: 3, title: 'U2', author: '', originalName: 'u.epub', format: 'epub' }, newId)
      const u2Book = (await lib.localBookId('ef'.repeat(32)))!
      await lib.setAccount('u2')
      const w = warnings()
      // A pass asked between the epoch bump and the re-render: fresh epoch, the old user id.
      const calls = fakeApi({})
      expect(await syncLibrary(lib, host({ userId: 'u1' }))).toBe('refused')
      expect(writes(calls)).toEqual([])
      expect((await lib.books()).map((b) => b.id)).toEqual([u2Book])
      expect(await lib.owner()).toEqual({ id: 'u2', guest: false })
      expect(bookId).not.toBe(u2Book)
      w.restore()
    })

    it('passWaitingWhenTheSessionEnds_DroppedUnrunNothingUnderTheOldUser', async () => {
      const { lib } = await synced()
      const { release, slow } = gated(lib)
      const calls = fakeApi({})
      const first = syncLibrary(slow, host())
      const queued = syncLibrary(lib, host()) // a save's pass, waiting for the running one
      syncStore.reset() // sign-out: the epoch bump, then the wipe
      await lib.wipe()
      release()
      expect(await first).toBe('dropped')
      expect(await queued).toBe('dropped')
      expect(calls.filter((c) => c.path === '/library/changes')).toEqual([])
      expect(await lib.owner()).toBeNull() // never re-recorded on the wiped library
    })

    // H: sign-out pushes only, in its own slot.
    describe('pushBeforeSignOut', () => {
      it('push_OutboxOnlyNoPulls_OwnSlotWhileAReaderPassRuns', async () => {
        const { lib, bookId, fileId } = await withUnsent()
        const { release, slow } = gated(lib)
        fakeApi({})
        const readerPass = syncLibrary(slow, host()) // a reader screen's pass, held
        const calls = fakeApi({
          [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))],
          [`PUT /annotations/${HL2.id}`]: [ok({ ...serverAnnotation(bookId, fileId, 1), id: HL2.id }, 201)],
        })
        await pushBeforeSignOut('u1', false, 1000, () => lib)
        // Done while the reader's pass still waits: its own slot; nothing pulled.
        expect(writes(calls)).toEqual([`PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL2.id}`])
        expect(calls.filter((c) => c.path.endsWith('/changes'))).toEqual([])
        expect(await lib.outbox()).toEqual([])
        release()
        expect(await readerPass).toBe('done')
      })

      it('push_Hangs_GivesUpAtTheDeadline', async () => {
        const { lib } = await synced()
        const { release, slow } = gated(lib)
        fakeApi({})
        const started = Date.now()
        await pushBeforeSignOut('u1', false, 50, () => slow)
        expect(Date.now() - started).toBeLessThan(1000)
        release()
        await pushBeforeSignOut('u1', false, 1000, () => lib) // the held push ends; nothing left running
      })
    })
  })

  describe('file sync (opt-in)', () => {
    it('fileSync_OffByDefault_NoUpload_OnUploadsBooksTheServerLacks', async () => {
      const { lib, bookId } = await synced()
      const upload = vi.fn(async () => {})
      fakeApi({})
      await syncLibrary(lib, host({ upload }))
      expect(upload).not.toHaveBeenCalled()
      await lib.setFileSync(true)
      await syncLibrary(lib, host({ upload }))
      expect(upload).toHaveBeenCalledWith(expect.objectContaining({ id: bookId }), 1024, expect.any(Function))
      expect(await lib.book(bookId)).toMatchObject({ has_content: 1 })
      upload.mockClear()
      await syncLibrary(lib, host({ upload }))
      expect(upload).not.toHaveBeenCalled()
    })

    it('fileSync_ContentRemovedOrQuotaFull_NothingMoreSent', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.setFileSync(true)
      fakeApi({ 'GET /library/changes': feed(serverBook(bookId, fileId, {}, { contentRemovedAt: '2026-11-10T00:00:00Z' })) })
      const upload = vi.fn(async () => { throw new FileUploadError('quota_exceeded', { used: 1, limit: 1 }) })
      await syncLibrary(lib, host({ upload }))
      expect(upload).not.toHaveBeenCalled()
      fakeApi({ 'GET /library/changes': feed(serverBook(bookId, fileId)) })
      expect(await syncLibrary(lib, host({ upload }))).toBe('done')
      expect(upload).toHaveBeenCalledTimes(1)
      expect(await lib.book(bookId)).toMatchObject({ has_content: 0 })
    })

    it('fileSync_ServerBookNotTheOneKnown_NoUploadMarkedBookPushedAgain', async () => {
      const { lib, bookId } = await synced()
      await lib.setFileSync(true)
      fakeApi({})
      const upload = vi.fn(async () => { throw new UploadNotOnServer(bookId) })
      await syncLibrary(lib, host({ upload }))
      expect(await lib.book(bookId)).toMatchObject({ has_content: 0, server_file_id: null })
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['book'])
    })
  })

  describe('review round 1 (#1038)', () => {
    const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
    const sfid = 'aaaaaaaa-0000-4000-8000-000000000002'

    it('readEntry_PickedFileIsAPulledBookNotImportedHere_RestoresTheAccountsPosition', async () => {
      const lib = createLocalLibrary(memoryDb())
      fakeApi({
        'GET /library/changes': feed(serverBook(sid, sfid, {}, { hasContent: true })),
        'GET /reading/changes': feed(serverState(sid, sfid, 3, { bookFraction: 0.66 })),
      })
      await syncLibrary(lib, host())
      // The page opens the picked bytes and asks for its entry before addOpened adopts the row.
      expect((await restoredEntry(lib)).position).toMatchObject({ cfi: CFI, fraction: 0.66 })
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      expect(await lib.localBookId(SHA)).toBe(sid)
      expect((await restoredEntry(lib)).position).toMatchObject({ fraction: 0.66 })
    })

    it('invalidPayload_BookParked_ChildrenNeverReAskForIt_UntilTheBookChanges', async () => {
      const { lib, bookId } = await seeded()
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [conflict('invalid_payload', { field: 'title' }, 400)],
      })
      for (let i = 0; i < 3; i++) await syncLibrary(lib, host())
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`])
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['state', 'annotation'])
      expect((await lib.book(bookId))?.blocked).toBeTruthy()
      // The page reports another format for it: sent again.
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'mobi' }, newId)
      expect((await lib.book(bookId))?.blocked).toBeNull()
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['book', 'state', 'annotation'])
    })

    it('singleFlight_TriggerDuringAPass_OneMorePassAfterIt', async () => {
      const lib = createLocalLibrary(memoryDb())
      const calls = fakeApi({})
      const first = syncLibrary(lib, host())
      const second = syncLibrary(lib, host())
      expect(await first).toBe('done')
      expect(await second).toBe('done')
      expect(calls.filter((c) => c.path === '/library/changes')).toHaveLength(2)
    })

    it('singleFlight_NewSessionJoinsADroppedPass_ItsOwnPassRuns', async () => {
      const lib = createLocalLibrary(memoryDb())
      let release: () => void = () => {}
      let held = false
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const path = url.replace(V2, '').split('?')[0]
        const body = path === '/status' ? { maxPartBytes: 1024 } : { items: [], cursor: null, hasMore: false }
        if (path === '/library/changes' && !held) {
          held = true
          await new Promise<void>((r) => { release = r })
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(body) }
      }))
      const old = syncLibrary(lib, host())
      for (let i = 0; i < 20 && !held; i++) await new Promise((r) => setTimeout(r, 0))
      syncStore.reset() // signed out; another session asks for a sync while the old pass is in flight
      // The same account signing back in (another account's pass would be refused: #1070 rule D).
      const fresh = syncLibrary(lib, host())
      release()
      expect(await fresh).toBe('done')
      expect(await old).toBe('done') // both callers see the last pass's result
      expect(await lib.account()).toBe('u1')
    })

    it('download_BytesAnotherBookHereHolds_NoSecondLocalCopy', async () => {
      const { lib } = await synced()
      fakeApi({ 'GET /library/changes': feed(serverBook(sid, sfid, {}, { hasContent: true })) })
      await syncLibrary(lib, host())
      expect((await lib.books()).map((b) => b.local)).toEqual([true])
      const io = { fetch: vi.fn(async () => 'staging/x.epub'), retain: vi.fn(async () => {}) }
      expect(await downloadBook(lib, sid, io)).toBe(false)
      expect(io.fetch).not.toHaveBeenCalled()
    })

    it('adoptAccount_ThenItsPass_ForgetsNothing_ReplayChangesNothing', async () => {
      const { lib, bookId, fileId } = await synced()
      expect(await lib.adoptAccount('u1', { [bookId]: 'acct-book' }, { [fileId]: 'acct-file' }, 'acct')).toBe(true)
      fakeApi({})
      await syncLibrary(lib, host({ userId: 'acct' }))
      expect(await lib.state('acct-book')).toMatchObject({ revision: 1 })
      // A replay (the identity already moved) changes nothing.
      expect(await lib.adoptAccount('u1', { [bookId]: 'acct-book' }, { [fileId]: 'acct-file' }, 'acct')).toBe(false)
      expect(await lib.book('acct-book')).toMatchObject({ file_id: 'acct-file' })
    })

    it('pull_SecondPageFailsToLand_FirstPageAndItsCursorKept', async () => {
      const lib = createLocalLibrary(memoryDb())
      const bad = { ...serverBook('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', {}, { sha256: 'ef'.repeat(32) }), title: null }
      fakeApi({
        'GET /library/changes': [
          ok({ items: [serverBook(sid, sfid, {}, { hasContent: true })], cursor: 'p1', hasMore: true }),
          ok({ items: [bad], cursor: 'p2', hasMore: false }),
        ],
      })
      expect(await syncLibrary(lib, host())).toBe('failed')
      expect(await lib.cursor('library')).toBe('p1')
      expect((await lib.books()).map((b) => b.id)).toEqual([sid])
    })

    it('park_SurvivesAMergeMapReKey', async () => {
      const { lib, bookId, fileId } = await seeded()
      await lib.setAccount('u1')
      expect(await lib.park({ kind: 'book', target: bookId, gen: 1, failures: 0 }, 'invalid_payload')).toBe(true)
      await lib.adoptAccount('u1', { [bookId]: 'acct-book' }, { [fileId]: 'acct-file' }, 'acct')
      expect(await lib.book('acct-book')).toMatchObject({ blocked: 'invalid_payload' })
    })
  })

  describe('outbox failure count: kept and skipped after N, per session, "Try again" (#1186)', () => {
    const E500 = [{ status: 500 }]
    /** Only the requests a pass makes for the outbox (the probe and the three feeds left out). */
    const pushCalls = (calls: Call[]) => calls.filter((c) => c.path !== '/status' && !c.path.endsWith('/changes')).map((c) => `${c.method} ${c.path}`)
    const passes = async (lib: LocalLibrary, count: number, h = host()) => { for (let i = 0; i < count; i++) await syncLibrary(lib, h) }
    let warn = vi.fn<(...args: unknown[]) => void>()
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) as unknown as typeof warn })
    afterEach(() => warn.mockRestore())

    it('failures_Book500NTimes_KeptSkippedNotParked_NextPassNoRequestNoLog_NewSessionRetries', async () => {
      const { lib, bookId } = await seeded()
      const calls = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: E500 })
      await passes(lib, MAX_FAILURES)
      expect(pushCalls(calls).filter((c) => c.startsWith('PUT'))).toHaveLength(MAX_FAILURES)
      // Failures never park: the entry is kept, the children wait for it uncounted.
      expect((await lib.book(bookId))?.blocked).toBeNull()
      expect((await lib.outbox()).map((o) => `${o.kind}:${o.failures}`)).toEqual([`book:${MAX_FAILURES}`, 'state:0', 'annotation:0'])
      expect((await lib.books())[0].notSynced).toBe(CHANGES_NOT_SYNCED)
      warn.mockClear()
      const next = fakeApi({})
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(pushCalls(next)).toEqual([])
      expect(warn).not.toHaveBeenCalled()
      // The next session tries it again.
      const fresh = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: E500 })
      await syncLibrary(lib, host({ retryFailed: true }))
      expect(writes(fresh)).toEqual([`PUT /books/${bookId}`])
      expect((await lib.outbox('book'))[0].failures).toBe(1)
    })

    it('outage_502OnEveryPutForNPasses_HealthyServerNewSession_EverythingPushedNoTryAgain', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }, [{ ...highlight, color: 'green' }]), newId)
      const SHA2 = 'cd'.repeat(32)
      await lib.addOpened({ sha256: SHA2, size: 10, title: 'U', author: '', originalName: 'u.epub', format: 'epub' }, newId)
      const other = (await lib.localBookId(SHA2))!
      const E502 = [{ status: 502 }]
      fakeApi({
        [`GET /books/by-sha256/${SHA2}`]: [{ status: 404 }],
        [`PUT /books/${other}`]: E502, [`PUT /books/${bookId}/reading-state`]: E502, [`PUT /annotations/${HL}`]: E502,
      })
      await passes(lib, MAX_FAILURES)
      expect((await lib.books()).map((b) => b.notSynced)).toEqual([CHANGES_NOT_SYNCED, CHANGES_NOT_SYNCED])
      expect((await lib.book(other))?.blocked).toBeNull()
      const healthy = fakeApi({
        [`GET /books/by-sha256/${SHA2}`]: [{ status: 404 }],
        [`PUT /books/${other}`]: [ok(serverBook(other, (await lib.book(other))!.file_id!, {}, { sha256: SHA2 }), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 2, { color: 'green' }))],
      })
      expect(await syncLibrary(lib, host({ retryFailed: true }))).toBe('done')
      expect(writes(healthy)).toEqual([`PUT /books/${other}`, `PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL}`])
      expect(await lib.outbox()).toEqual([])
      expect((await lib.books()).map((b) => b.notSynced)).toEqual([null, null])
    })

    it('retryFailed_AskedWhileAPassRuns_NotLostToALaterPlainTrigger', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: E500 })
      await passes(lib, MAX_FAILURES)
      const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))] })
      const running = syncLibrary(lib, host())
      void syncLibrary(lib, host({ retryFailed: true }))
      await syncLibrary(lib, host())
      await running
      expect(writes(calls)).toEqual([`PUT /books/${bookId}/reading-state`])
      expect(await lib.outbox()).toEqual([])
    })

    it('staleRevision_InPassRetryExhausted_CountedAsAFailedAttempt', async () => {
      const { lib, bookId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [conflict('stale_revision')] })
      expect(await syncLibrary(lib, host())).toBe('failed')
      expect(writes(calls)).toHaveLength(2)
      expect((await lib.outbox()).map((o) => `${o.kind}:${o.failures}`)).toEqual(['state:1'])
    })

    it('tryAgain_NoSession_ListRefreshedRightAfterTheUnpark', async () => {
      const { lib, bookId } = await seeded()
      await lib.park({ kind: 'book', target: bookId, gen: 1, failures: 0 }, 'invalid_payload')
      const order: string[] = []
      const refresh = vi.fn(async () => { order.push('refresh'); return lib.books() })
      await tryAgainBook(lib, bookId, refresh, () => order.push('sync'))
      expect(order).toEqual(['refresh', 'sync'])
      expect((await refresh.mock.results[0].value)[0].notSynced).toBeNull()
    })

    it('park_ServerTurnsOutToHoldTheBook_ParkClearedChildrenPushed', async () => {
      const { lib, bookId, fileId } = await seeded()
      await lib.park({ kind: 'book', target: bookId, gen: 1, failures: 0 }, 'invalid_payload')
      expect((await lib.books())[0].notSynced).toBe('invalid_payload')
      const calls = fakeApi({
        'GET /library/changes': feed(serverBook(bookId, fileId)),
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect((await lib.books())[0].notSynced).toBeNull()
      expect(writes(calls)).toEqual([`PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL}`])
    })

    it('failures_StateAndAnnotation500NTimes_KeptSkippedLocalDataIntact_LoggedOnce', async () => {
      const { lib, bookId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }, [{ ...highlight, color: 'green' }]), newId)
      const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: E500, [`PUT /annotations/${HL}`]: E500 })
      await passes(lib, MAX_FAILURES)
      expect(pushCalls(calls)).toHaveLength(2 * MAX_FAILURES)
      expect((await lib.outbox()).map((o) => `${o.kind}:${o.failures}`)).toEqual([`state:${MAX_FAILURES}`, `annotation:${MAX_FAILURES}`])
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('not retried until it changes'))).toHaveLength(2)
      warn.mockClear()
      const next = fakeApi({})
      await passes(lib, 2)
      expect(pushCalls(next)).toEqual([])
      expect(warn).not.toHaveBeenCalled()
      // Nothing local lost.
      const back = await restoredEntry(lib)
      expect(back.position.fraction).toBe(0.5)
      expect(back.highlights[0].color).toBe('green')
    })

    it('failures_OfflineOr503OrDroppedPass_NotCounted', async () => {
      const { lib, bookId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: [{ status: 503 }] })
      expect(await syncLibrary(lib, host())).toBe('failed')
      fakeApi({})
      const online = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === 'PUT') throw new TypeError('Network request failed')
        return online(url, init)
      }))
      expect(await syncLibrary(lib, host())).toBe('failed')
      expect(await resetMidCall(() => syncStore.reset(), {
        'GET /status': ok({ maxPartBytes: 1024 }),
        'GET /library/changes': feed()[0], 'GET /reading/changes': feed()[0], 'GET /annotations/changes': feed()[0], 'GET /vocabulary/changes': feed()[0],
        [`PUT /books/${bookId}/reading-state`]: { status: 500 },
      }, () => syncLibrary(lib, host()), '/reading-state')).toBe('dropped')
      expect((await lib.outbox()).map((o) => `${o.kind}:${o.failures}`)).toEqual(['state:0'])
      // ...and a 500 is counted.
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: E500 })
      await syncLibrary(lib, host())
      expect((await lib.outbox())[0].failures).toBe(1)
    })

    it('failures_NewSaveResetsTheCount_SaveDuringAFailingPushNotCountedAgainstIt', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: E500 })
      await passes(lib, MAX_FAILURES)
      expect((await lib.outbox())[0].failures).toBe(MAX_FAILURES)
      // A new save: a fresh attempt.
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.55, at: NOW - 90 }), newId)
      expect((await lib.outbox())[0].failures).toBe(0)
      // A save lands while the failing push is in flight: the 500 counts against the old gen only.
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const path = url.replace(V2, '').split('?')[0]
        if (path === '/status') return { ok: true, status: 200, text: async () => JSON.stringify({ maxPartBytes: 1024 }) }
        if (path.endsWith('/changes')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [], cursor: null, hasMore: false }) }
        await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.6, at: NOW - 80 }), newId)
        return { ok: false, status: 500, text: async () => '' }
      }))
      warn.mockClear()
      await syncLibrary(lib, host())
      const [item] = await lib.outbox()
      expect(item.failures).toBe(0)
      expect(warn).not.toHaveBeenCalled() // the old gen's failure: neither counted nor logged
      const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))] })
      await syncLibrary(lib, host())
      expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ bookFraction: 0.6 })
      expect(await lib.outbox()).toEqual([])
    })

    it('tryAgain_StuckBookAndChild_RetriedFromZero_FailingAgainStopsAfterNMore_ThenPushedSamePass', async () => {
      const { lib, bookId, fileId } = await seeded()
      const failing = () => fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: E500 })
      failing()
      await passes(lib, MAX_FAILURES)
      const [state] = await lib.outbox('state')
      for (let i = 0; i < MAX_FAILURES; i++) await lib.failed(state)
      await lib.unpark(bookId)
      expect((await lib.books())[0].notSynced).toBeNull()
      expect((await lib.outbox()).map((o) => `${o.kind}:${o.failures}`)).toEqual(['book:0', 'state:0', 'annotation:0'])
      // Fails again: stops after N more.
      const calls = failing()
      await passes(lib, MAX_FAILURES + 1)
      expect(pushCalls(calls).filter((c) => c.startsWith('PUT'))).toHaveLength(MAX_FAILURES)
      expect((await lib.books())[0].notSynced).toBe(CHANGES_NOT_SYNCED)
      // "Try again" and the server takes it: the children follow in the same pass.
      await lib.unpark(bookId)
      const ok2 = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(ok2)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL}`])
      expect(await lib.outbox()).toEqual([])
    })

    it('failures_MergeMapReKeyKeepsTheCount', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: E500 })
      await passes(lib, MAX_FAILURES)
      await lib.adoptAccount('u1', { [bookId]: 'acct-book' }, { [fileId]: 'acct-file' }, 'acct')
      expect((await lib.outbox()).map((o) => `${o.target}:${o.failures}`)).toEqual([`acct-book:${MAX_FAILURES}`])
      // Another identity wipes the library (#1070): no count, no entry is left to carry over.
    })

    it('migration_OutboxWithoutTheColumn_UpgradedOnOpen_TwoColdStarts', async () => {
      const db = memoryDb()
      db.raw.exec(`CREATE TABLE outbox (kind TEXT NOT NULL, target TEXT NOT NULL, gen INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (kind, target));
        INSERT INTO outbox (kind, target) VALUES ('state', 'b1')`)
      expect(await createLocalLibrary(db).outbox()).toEqual([{ kind: 'state', target: 'b1', gen: 1, failures: 0 }])
      const again = createLocalLibrary(db)
      await again.failed({ kind: 'state', target: 'b1', gen: 1, failures: 0 })
      expect(await again.outbox()).toEqual([{ kind: 'state', target: 'b1', gen: 1, failures: 1 }])
    })
  })

  describe('#1186 fix round', () => {
    let warn = vi.fn<(...args: unknown[]) => void>()
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) as unknown as typeof warn })
    afterEach(() => warn.mockRestore())

    it('migration_OnlyDuplicateColumnSwallowed_AnyOtherAlterFailureRejects', async () => {
      const db = memoryDb()
      let broken = true
      const lib = createLocalLibrary({
        ...db,
        execAsync: async (sql: string) => {
          if (broken && sql.startsWith('ALTER TABLE outbox')) throw new Error('Error code 13: database or disk is full')
          return db.execAsync(sql)
        },
      })
      await expect(lib.outbox()).rejects.toThrow('disk is full')
      broken = false
      // Tried again on the next call; the duplicate `blocked` column (CREATE already has it) is ignored.
      expect(await lib.outbox()).toEqual([])
    })

    it('reasons_LocalErrorNameOnly_InvalidPayloadMessageClipped', async () => {
      const db = memoryDb()
      const lib = createLocalLibrary(db)
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      const bookId = (await lib.localBookId(SHA))!
      await lib.writeEntry(SHA, entry(), newId)
      const fileId = (await lib.book(bookId))!.file_id!
      db.raw.exec(`UPDATE reading_state SET position = '{secret book text'`)
      fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
      })
      await syncLibrary(lib, host())
      const logged = JSON.stringify(warn.mock.calls)
      expect(logged).toContain('SyntaxError')
      expect(logged).not.toMatch(/secret|JSON/)
      // A refusal's server message is clipped like any other reason.
      await lib.addOpened({ sha256: 'cd'.repeat(32), size: 10, title: 'U', author: '', originalName: 'u.epub', format: 'epub' }, newId)
      const other = (await lib.localBookId('cd'.repeat(32)))!
      fakeApi({
        [`GET /books/by-sha256/${'cd'.repeat(32)}`]: [{ status: 404 }],
        [`PUT /books/${other}`]: [{ status: 400, body: { code: 'invalid_payload', field: 'title', message: 'y'.repeat(300) } }],
      })
      await syncLibrary(lib, host())
      expect((await lib.book(other))?.blocked).toBe(`400 invalid_payload: ${'y'.repeat(120)} (title)`)
    })
  })

  // QA #1186: mutation survivors killed, plus the repros, fixed or pinned as decisions in the fix round.
  describe('QA #1186 (outbox backoff)', () => {
    const E500 = [{ status: 500 }]
    const bookImport500 = (bookId: string) => ({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: E500 })
    const passes = async (lib: LocalLibrary, count: number, h = host()) => { for (let i = 0; i < count; i++) await syncLibrary(lib, h) }
    const counts = async (lib: LocalLibrary) => (await lib.outbox()).map((o) => `${o.kind}:${o.failures}`)
    let warn = vi.fn<(...args: unknown[]) => void>()
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) as unknown as typeof warn })
    afterEach(() => warn.mockRestore())

    it('qa_failureLog_LongServerMessage_StatusCodeAndMessageClippedTo120', async () => {
      const { lib, bookId } = await seeded()
      fakeApi({ ...bookImport500(bookId), [`PUT /books/${bookId}`]: [{ status: 500, body: { code: 'internal', message: 'x'.repeat(300) } }] })
      await passes(lib, 1)
      expect(warn.mock.calls.map((c) => c[1])).toContain(`500 internal: ${'x'.repeat(120)}`)
    })

    it('qa_unpark_QueuedAnnotationChildStoppedRetrying_RetriedFromZero', async () => {
      const { lib, bookId } = await seeded()
      fakeApi(bookImport500(bookId))
      await passes(lib, MAX_FAILURES)
      const [annotation] = await lib.outbox('annotation')
      for (let i = 0; i < MAX_FAILURES; i++) await lib.failed(annotation)
      await lib.unpark(bookId)
      expect(await counts(lib)).toEqual(['book:0', 'state:0', 'annotation:0'])
    })

    it('qa_queueBook_AlreadyQueued_KeepsItsGenAndCount', async () => {
      const lib = createLocalLibrary(memoryDb())
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      const bookId = (await lib.localBookId(SHA))!
      await lib.failed({ kind: 'book', target: bookId, gen: 1, failures: 0 })
      await lib.queueBook(bookId)
      expect(await lib.outbox()).toEqual([{ kind: 'book', target: bookId, gen: 1, failures: 1 }])
    })

    it('qa_droppedPass_500ArrivesAfterTheSessionChanged_NotCountedNotLogged', async () => {
      const { lib, bookId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      warn.mockClear()
      expect(await resetMidCall(() => syncStore.reset(), {
        'GET /status': ok({ maxPartBytes: 1024 }),
        'GET /library/changes': feed()[0], 'GET /reading/changes': feed()[0], 'GET /annotations/changes': feed()[0], 'GET /vocabulary/changes': feed()[0],
        [`PUT /books/${bookId}/reading-state`]: { status: 500 },
      }, () => syncLibrary(lib, host()), '/reading-state')).toBe('dropped')
      expect(await counts(lib)).toEqual(['state:0'])
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('not pushed'))).toEqual([])
    })

    it('qa_stateStaleRetryInsideThePassFails500_CountedOncePerPass', async () => {
      const { lib, bookId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [conflict('stale_revision'), { status: 500 }] })
      await syncLibrary(lib, host())
      expect(writes(calls)).toHaveLength(2)
      expect(await counts(lib)).toEqual(['state:1'])
    })

    it('qa_corruptLocalPosition_ThrowsLocally_CountedThenSkipped_AnnotationStillPushed', async () => {
      const db = memoryDb()
      const lib = createLocalLibrary(db)
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      const bookId = (await lib.localBookId(SHA))!
      await lib.writeEntry(SHA, entry(), newId)
      const fileId = (await lib.book(bookId))!.file_id!
      db.raw.exec(`UPDATE reading_state SET position = '{not json'`)
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
      })
      await passes(lib, MAX_FAILURES + 2)
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /annotations/${HL}`])
      expect(await counts(lib)).toEqual([`state:${MAX_FAILURES}`])
      expect(await lib.state(bookId)).toMatchObject({ position: '{not json' }) // kept, never dropped
    })

    // (a) A child skipped for its own 500s while its book is fine: the book says so, with "Try again".
    it('qa_skippedAnnotation_BookFine_NotSyncedShownPassDoneZeroRequests', async () => {
      const { lib } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      fakeApi({ [`PUT /annotations/${HL}`]: E500 })
      await passes(lib, MAX_FAILURES)
      const calls = fakeApi({})
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([])
      expect((await lib.books()).map((b) => b.notSynced)).toEqual([CHANGES_NOT_SYNCED])
      expect(await counts(lib)).toEqual([`annotation:${MAX_FAILURES}`])
      // "Try again" on a book that is not parked: its children retried, the book not re-sent.
      await lib.unpark((await lib.books())[0].id)
      expect(await counts(lib)).toEqual(['annotation:0'])
      expect((await lib.books()).map((b) => b.notSynced)).toEqual([null])
    })

    // (a) ...the queued entry shadows the server's newer edit (applyAnnotations skips a queued id) until
    // "Try again": then the normal conflict path converges (stale_revision → ours once on theirs).
    it('qa_skippedAnnotation_NewerEditFromAnotherDevice_TryAgainConvergesThroughStaleRevision', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      fakeApi({ [`PUT /annotations/${HL}`]: E500 })
      await passes(lib, MAX_FAILURES)
      const blue = serverAnnotation(bookId, fileId, 5, { color: 'blue' })
      fakeApi({ 'GET /annotations/changes': feed(blue), [`PUT /annotations/${HL}`]: E500 })
      await passes(lib, 2)
      expect((await restoredEntry(lib)).highlights[0].color).toBe('green') // shadowed, as decided
      await lib.unpark(bookId)
      const calls = fakeApi({
        [`PUT /annotations/${HL}`]: [conflict('stale_revision', { revision: 5, current: blue }), ok(serverAnnotation(bookId, fileId, 6, { color: 'green' }))],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.expectedRevision)).toEqual([1, 5])
      expect(await lib.annotation(HL)).toMatchObject({ revision: 6 })
      expect((await restoredEntry(lib)).highlights[0].color).toBe('green')
      expect(await lib.outbox()).toEqual([])
    })

    // (b) "Try again" landing while the Nth failing push is in flight: that failure is the first of the fresh count.
    it('qa_unparkDuringTheNthFailingPush_NothingLocalLost_PushedNextTime', async () => {
      const { lib, bookId, fileId } = await seeded()
      fakeApi(bookImport500(bookId))
      await passes(lib, MAX_FAILURES - 1)
      const failing = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === 'PUT') await lib.unpark(bookId)
        return failing(url, init)
      }))
      await syncLibrary(lib, host())
      expect(await counts(lib)).toEqual(['book:1', 'state:0', 'annotation:0'])
      expect(await lib.state(bookId)).toMatchObject({ position: expect.any(String) })
      const ok2 = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(ok2)).toHaveLength(3)
    })

    it('qa_unparkDuringTheNthFailingPush_LoggedFromTheRowCount_NoFalseNotRetried', async () => {
      const { lib, bookId } = await seeded()
      fakeApi(bookImport500(bookId))
      await passes(lib, MAX_FAILURES - 1)
      const failing = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === 'PUT') await lib.unpark(bookId)
        return failing(url, init)
      }))
      warn.mockClear()
      await syncLibrary(lib, host())
      const logged = warn.mock.calls.map((c) => String(c[0]))
      expect(logged.some((l) => l.includes(`(1/${MAX_FAILURES})`))).toBe(true)
      expect(logged.some((l) => l.includes('not retried until'))).toBe(false)
      expect((await lib.books())[0].notSynced).toBeNull()
    })

    // (c) id_conflict, then the retry under the new id fails: counted against the new target, stops on time.
    it('qa_idConflictThenRetry500_StopsAfterMaxFailures', async () => {
      const { lib, bookId } = await seeded()
      const nid = '00000000-0000-4000-8000-000000000003' // newId()'s next
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [conflict('id_conflict')],
        [`PUT /books/${nid}`]: E500,
      })
      await passes(lib, MAX_FAILURES + 1)
      expect(writes(calls).filter((w) => w === `PUT /books/${nid}`)).toHaveLength(MAX_FAILURES)
      expect((await lib.outbox('book'))[0]).toMatchObject({ target: nid, failures: MAX_FAILURES })
      expect((await lib.book(nid))?.blocked).toBeNull()
    })

    it('qa_idConflictThenRetry500_CountedAgainstTheNewTarget', async () => {
      const { lib, bookId } = await seeded()
      const nid = '00000000-0000-4000-8000-000000000003'
      fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [conflict('id_conflict')], [`PUT /books/${nid}`]: E500 })
      await syncLibrary(lib, host())
      expect((await lib.outbox('book'))[0]).toMatchObject({ target: nid, failures: 1 })
    })

    // Terminal refusals: "Try again" costs one request and parks again; no loop.
    it('qa_unparkAfterInvalidPayload_OneRequestPerTryAgain_ParkedAgainNoLoop', async () => {
      const { lib, bookId } = await seeded()
      const calls = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [conflict('invalid_payload', { field: 'title' }, 400)] })
      await syncLibrary(lib, host())
      await lib.unpark(bookId)
      await passes(lib, 3)
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}`])
      expect((await lib.book(bookId))?.blocked).toMatch(/invalid_payload/)
    })

    // Another account's passes are refused (#1070 rule D): a parked book is not sent to it.
    it('qa_bookParkedByARefusal_AnotherAccount_RefusedNothingSent', async () => {
      const lib = createLocalLibrary(memoryDb())
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      const bookId = (await lib.localBookId(SHA))!
      fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [conflict('invalid_payload', { field: 'title' }, 400)] })
      await passes(lib, 1)
      expect((await lib.book(bookId))?.blocked).toMatch(/invalid_payload/)
      syncStore.reset()
      const calls = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [ok(serverBook(bookId, (await lib.book(bookId))!.file_id!), 201)] })
      await passes(lib, 2, host({ userId: 'u2' }))
      expect(writes(calls)).toEqual([])
      expect((await lib.books()).map((b) => b.id)).toEqual([bookId])
    })

    // A child the server keeps answering unknown_file (the book re-adopted every pass) is counted like any failure.
    it('qa_stateUnknownFileEveryPass_BookAdoptedEveryPass_StopsAfterMaxFailures', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [ok(serverBook(bookId, fileId))],
        [`PUT /books/${bookId}/reading-state`]: [conflict('unknown_file', {}, 404)],
      })
      await passes(lib, 3 * MAX_FAILURES)
      expect(writes(calls)).toHaveLength(MAX_FAILURES)
      expect(await counts(lib)).toEqual([`state:${MAX_FAILURES}`])
    })

    // Decision (fix round): any 503 is the server down, `v2_unavailable` or not: the pass ends, nothing is
    // counted (counting would park a whole library in an outage); later entries wait for the next pass.
    it('qa_oneEntryAnswers503WithoutV2Unavailable_PassEndsNothingCounted', async () => {
      const { lib, bookId } = await seeded()
      const SHA2 = 'cd'.repeat(32)
      await lib.addOpened({ sha256: SHA2, size: 10, title: 'U', author: '', originalName: 'u.epub', format: 'epub' }, newId)
      const other = (await lib.localBookId(SHA2))!
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`GET /books/by-sha256/${SHA2}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [{ status: 503, body: { code: 'internal', message: 'upstream' } }],
        [`PUT /books/${other}`]: [ok(serverBook(other, (await lib.book(other))!.file_id!, {}, { sha256: SHA2 }), 201)],
      })
      for (let i = 0; i < 3; i++) expect(await syncLibrary(lib, host())).toBe('failed')
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}`, `PUT /books/${bookId}`])
      expect(await counts(lib)).toEqual(['book:0', 'book:0', 'state:0', 'annotation:0'])
    })

    // #1198: a failing upload is counted per book: at the limit it waits for the next session or "Try again", and
    // the outbox is untouched (the book's writes still go). An outage (a 503) ends the pass and is never counted.
    it('qa_fileSyncUploadFailing_CountedPerBook_StopsAtTheLimitShownNotSynced_OutageNotCounted_NextSessionOrTryAgainRetries', async () => {
      const { lib, bookId } = await synced()
      await lib.setFileSync(true)
      fakeApi({})
      const outage = vi.fn(async () => { throw new ApiError(503, 'paused') })
      expect(await syncLibrary(lib, host({ upload: outage }))).toBe('failed')
      await passes(lib, MAX_FAILURES + 1, host({ upload: outage }))
      expect(outage).toHaveBeenCalledTimes(MAX_FAILURES + 2)

      const upload = vi.fn(async () => { throw new Error('upload 500') })
      await passes(lib, MAX_FAILURES + 2, host({ upload }))
      expect(upload).toHaveBeenCalledTimes(MAX_FAILURES)
      expect(await lib.outbox()).toEqual([])
      // #1593: the stop shows on the book, as a stuck outbox entry does.
      expect((await lib.books())[0].notSynced).toBe(FILE_NOT_UPLOADED)

      await syncLibrary(lib, host({ upload, retryFailed: true }))
      expect(upload).toHaveBeenCalledTimes(MAX_FAILURES + 1)

      await passes(lib, MAX_FAILURES, host({ upload }))
      expect(upload).toHaveBeenCalledTimes(2 * MAX_FAILURES)
      await tryAgainBook(lib, bookId, async () => {}, () => {})
      expect((await lib.books())[0].notSynced).toBeNull()
      await syncLibrary(lib, host({ upload }))
      expect(upload).toHaveBeenCalledTimes(2 * MAX_FAILURES + 1)
    })
  })

  describe('a stopped upload on the book (#1593)', () => {
    /** A pushed book whose upload failed MAX_FAILURES times, file sync on; and its database (a launch is a new library on it). */
    async function uploadStopped() {
      const db = memoryDb()
      const lib = createLocalLibrary(db)
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      const id = (await lib.localBookId(SHA))!
      const fileId = (await lib.book(id))!.file_id!
      await lib.setServerFile(id, serverFile(fileId) as never)
      await lib.setFileSync(true)
      for (let i = 0; i < MAX_FAILURES; i++) await lib.uploadFailed(id)
      expect((await lib.books())[0].notSynced).toBe(FILE_NOT_UPLOADED)
      return { db, lib, id, fileId }
    }

    it('books_UploadStoppedThenAPullSaysTheServerHasTheBytes_NotFlagged', async () => {
      const { lib, id, fileId } = await uploadStopped()
      await lib.applyBooks([serverBook(id, fileId, {}, { hasContent: true })] as never)
      expect((await lib.books())[0].notSynced).toBeNull()
    })

    it('books_UploadStoppedThenFileSyncOff_NotFlagged', async () => {
      const { lib } = await uploadStopped()
      await lib.setFileSync(false)
      expect((await lib.books())[0].notSynced).toBeNull()
    })

    it('uploadable_UploadStoppedThenTheAppLaunchesAgain_RetriedWhateverTheFirstPassDoes', async () => {
      const { db, id } = await uploadStopped()
      const relaunched = createLocalLibrary(db)
      expect((await relaunched.books())[0].notSynced).toBeNull()
      expect((await relaunched.uploadable()).map((b) => b.id)).toEqual([id])
    })
  })

  // #1312: notes (the host's) ride every write; a removal here is a DELETE; a lost write keeps the server's note
  // unless this device edited it.
  // #1314: a bookmark is the page's highlight of colour `bookmark`: the same row, queue, write and tombstone.
  describe('bookmarks (#1314)', () => {
    const BM = '0b6a2c1e-2222-4222-8333-444455556666'
    const BM_CFI = 'epubcfi(/6/14!/4/2,/1:0,/1:24)'
    // The page's form (bookmarks.mjs / page.mjs `addBookmark`): the first words at the place, no context.
    const bookmark = { id: BM, cfi: BM_CFI, index: 6, quote: 'It was a bright cold day', selectedText: 'It was a bright cold day', prefix: '', suffix: '', color: 'bookmark', at: Date.parse('2026-11-15T10:00:00Z') }
    const serverBookmark = (bookId: string, fileId: string, revision: number, extra: object = {}) => ({
      id: BM, bookId, fileId, selectedText: bookmark.selectedText, noteText: null, color: 'bookmark',
      locator: { version: 1, scheme: 'epub-cfi', value: BM_CFI, quote: bookmark.quote },
      createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z', deletedAt: null, revision, ...extra,
    })
    const stored = async (lib: LocalLibrary) => JSON.parse((await lib.annotation(BM))!.highlight)

    it('added_StoredAsARow_PushedAsAnAnnotationOfColourBookmark_NotWrittenAgain', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [highlight, bookmark]), newId)
      expect(await stored(lib)).toEqual(bookmark)
      expect(await lib.outbox()).toEqual([expect.objectContaining({ kind: 'annotation', target: BM })])
      const calls = fakeApi({ [`PUT /annotations/${BM}`]: [ok(serverBookmark(bookId, fileId, 1), 201)] })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body])).toEqual([['PUT', `/annotations/${BM}`, {
        expectedRevision: null, bookId, fileId, selectedText: 'It was a bright cold day', noteText: null, color: 'bookmark',
        locator: { version: 1, scheme: 'epub-cfi', value: BM_CFI, quote: 'It was a bright cold day' },
      }]])
      expect(await lib.annotation(BM)).toMatchObject({ revision: 1, deleted_at: null })
      // The next open's entry carries it, as stored; the same entry stored again queues nothing.
      expect((await restoredEntry(lib)).highlights).toEqual([highlight, bookmark])
      await lib.writeEntry(SHA, entry(pos, [highlight, bookmark]), newId)
      expect(await lib.outbox()).toEqual([])
    })

    it('removed_TombstonedHere_ADeleteNeverAPut_GoneFromTheNextEntry', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [highlight, bookmark]), newId)
      fakeApi({ [`PUT /annotations/${BM}`]: [ok(serverBookmark(bookId, fileId, 1), 201)] })
      await syncLibrary(lib, host())
      // The page's `highlight-removed` for a bookmark is the highlights' own removal.
      expect(await lib.removeHighlight(BM, '2026-11-15T11:00:00.000Z')).toBe(true)
      expect((await restoredEntry(lib)).highlights).toEqual([highlight])
      const calls = fakeApi({ [`DELETE /annotations/${BM}`]: [ok(serverBookmark(bookId, fileId, 2, { deletedAt: '2026-11-15T11:00:01.000Z' }))] })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`DELETE /annotations/${BM}`])
      expect(await lib.annotation(BM)).toMatchObject({ revision: 2, deleted_at: '2026-11-15T11:00:01.000Z' })
      // A store from before the removal never brings it back.
      await lib.writeEntry(SHA, entry(pos, [highlight, bookmark]), newId)
      expect(await lib.outbox()).toEqual([])
      expect((await restoredEntry(lib)).highlights).toEqual([highlight])
    })

    it('pulledFromAnotherDevice_ARowInThePagesForm_InTheNextEntry_ItsTombstoneTellsTheHost', async () => {
      const { lib, bookId, fileId } = await synced()
      fakeApi({ 'GET /annotations/changes': feed(serverBookmark(bookId, fileId, 1)) })
      await syncLibrary(lib, host())
      // Exactly the form the page made on the other device: stored again by the page, it is no change.
      expect(await stored(lib)).toEqual(bookmark)
      expect((await restoredEntry(lib)).highlights).toEqual([highlight, bookmark])
      await lib.writeEntry(SHA, entry(pos, [highlight, bookmark]), newId)
      expect(await lib.outbox()).toEqual([])
      // Deleted there: the host reads it as deleted (and takes it off the page), the next entry has none.
      fakeApi({ 'GET /annotations/changes': feed(serverBookmark(bookId, fileId, 2, { deletedAt: '2026-11-15T12:00:00Z' })) })
      await syncLibrary(lib, host())
      expect((await lib.notes(SHA)).deleted).toEqual(new Set([BM]))
      expect((await restoredEntry(lib)).highlights).toEqual([highlight])
    })

    it('twin_ABookmarkPulledWhileOpen_TheSamePlaceOnThePageUnderAnotherId_ItsRemovalTombstonesThePulledRow (#1314 review)', async () => {
      const { lib, bookId, fileId } = await synced()
      // U2 comes from another device by a pull while the book is open (the page never receives it: no addHighlights on
      // Android); the reader made the same bookmark on the page meanwhile, as U3.
      const U3 = '0b6a2c1e-3333-4222-8333-444455556666'
      fakeApi({ 'GET /annotations/changes': feed(serverBookmark(bookId, fileId, 1)) })
      await syncLibrary(lib, host())
      await lib.writeEntry(SHA, entry(pos, [highlight, { ...bookmark, id: U3, at: bookmark.at + 5 }]), newId)
      expect(await lib.annotation(U3)).toBeFalsy()
      expect(lib.realId(U3)).toBe(BM)
      // The page's removal of U3 is the pulled row's: deleted here, its DELETE queued and sent.
      expect(await lib.removeHighlight(U3, '2026-11-16T10:00:00.000Z')).toBe(true)
      expect(await lib.annotation(BM)).toMatchObject({ deleted_at: '2026-11-16T10:00:00.000Z' })
      const calls = fakeApi({ [`DELETE /annotations/${BM}`]: [ok(serverBookmark(bookId, fileId, 2, { deletedAt: '2026-11-16T10:00:01.000Z' }))] })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`DELETE /annotations/${BM}`])
      expect((await restoredEntry(lib)).highlights).toEqual([highlight])
    })

    it('deviceHighlights_ABookmarkIsNotAHighlight', async () => {
      const { lib, bookId } = await seeded()
      await lib.writeEntry(SHA, entry(pos, [highlight, bookmark]), newId)
      expect(await lib.deviceHighlights()).toEqual([{ id: HL, bookId, bookTitle: 'T', text: 'bright cold', color: 'yellow', note: null, at: expect.anything() }])
    })
  })

  describe('notes and removals', () => {
    const putsOf = (calls: Call[]) => calls.filter((c) => c.method === 'PUT' && c.path === `/annotations/${HL}`).map((c) => c.body)

    it('note_SetHere_WrittenWithTheHighlightOnItsRevision_NoLongerAnEditAfter', async () => {
      const { lib, bookId, fileId } = await synced()
      expect(await lib.setNote(HL, 'a thought')).toBe(true)
      expect(await lib.outbox()).toEqual([expect.objectContaining({ kind: 'annotation', target: HL })])
      const calls = fakeApi({ [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 2, { noteText: 'a thought' }))] })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(putsOf(calls)).toEqual([expect.objectContaining({ expectedRevision: 1, noteText: 'a thought', color: 'yellow', selectedText: 'bright cold' })])
      expect(await lib.annotation(HL)).toMatchObject({ revision: 2, note: 'a thought', note_dirty: 0 })
      expect((await lib.notes(SHA)).known).toEqual(new Map([[HL, 'a thought']]))
      expect(await lib.outbox()).toEqual([])
    })

    it('recolour_ThePulledNoteKept_APutNeverClearsIt', async () => {
      const { lib, bookId, fileId } = await synced()
      fakeApi({ 'GET /annotations/changes': feed(serverAnnotation(bookId, fileId, 2, { noteText: 'from the web' })) })
      await syncLibrary(lib, host())
      expect(await lib.annotation(HL)).toMatchObject({ note: 'from the web', note_dirty: 0 })
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      const calls = fakeApi({ [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 3, { color: 'green', noteText: 'from the web' }))] })
      await syncLibrary(lib, host())
      expect(putsOf(calls)).toEqual([expect.objectContaining({ expectedRevision: 2, color: 'green', noteText: 'from the web' })])
    })

    it('staleRevision_NoteNotEditedHere_TheRetryTakesTheirNote', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'pink' }]), newId)
      const theirs = serverAnnotation(bookId, fileId, 3, { noteText: 'written elsewhere' })
      const calls = fakeApi({
        [`PUT /annotations/${HL}`]: [conflict('stale_revision', { revision: 3, current: theirs }), ok(serverAnnotation(bookId, fileId, 4, { color: 'pink', noteText: 'written elsewhere' }))],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(putsOf(calls).map((b) => [b.expectedRevision, b.color, b.noteText])).toEqual([[1, 'pink', null], [3, 'pink', 'written elsewhere']])
      expect(await lib.annotation(HL)).toMatchObject({ revision: 4, note: 'written elsewhere' })
    })

    it('staleRevision_NoteEditedHere_OursReappliedOnce', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.setNote(HL, 'mine')
      const calls = fakeApi({
        [`PUT /annotations/${HL}`]: [conflict('stale_revision', { revision: 3, current: serverAnnotation(bookId, fileId, 3, { noteText: 'theirs' }) }), ok(serverAnnotation(bookId, fileId, 4, { noteText: 'mine' }))],
      })
      await syncLibrary(lib, host())
      expect(putsOf(calls).map((b) => [b.expectedRevision, b.noteText])).toEqual([[1, 'mine'], [3, 'mine']])
      expect(await lib.annotation(HL)).toMatchObject({ revision: 4, note: 'mine', note_dirty: 0 })
    })

    it('noteEditedWhileItsWriteIsInFlight_StillAnEdit_WrittenNext', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.setNote(HL, 'first')
      const failing = fakeApi({ [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 2, { noteText: 'first' }))] })
      const real = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === 'PUT') await lib.setNote(HL, 'second')
        return real(url, init)
      }))
      await syncLibrary(lib, host())
      expect(putsOf(failing)).toHaveLength(1)
      expect(await lib.annotation(HL)).toMatchObject({ revision: 2, note: 'second', note_dirty: 1 })
      vi.unstubAllGlobals()
      const next = fakeApi({ [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 3, { noteText: 'second' }))] })
      await syncLibrary(lib, host())
      expect(putsOf(next).map((b) => [b.expectedRevision, b.noteText])).toEqual([[2, 'second']])
    })

    it('removal_ADeleteNeverAPut_AStoreHoldingItAfterwardsSkipped_TheTombstoneKept', async () => {
      const { lib, bookId, fileId } = await synced()
      expect(await lib.removeHighlight(HL, '2026-11-14T00:00:00.000Z')).toBe(true)
      expect((await restoredEntry(lib)).highlights).toEqual([])
      // The page's store from before the removal (a recolour) lands after it.
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'blue' }]), newId)
      expect(await lib.setNote(HL, 'too late')).toBe(false)
      const tomb = serverAnnotation(bookId, fileId, 2, { deletedAt: '2026-11-14T00:00:01.000Z' })
      const calls = fakeApi({ [`DELETE /annotations/${HL}`]: [ok(tomb)] })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`DELETE /annotations/${HL}`])
      expect(await lib.annotation(HL)).toMatchObject({ revision: 2, deleted_at: '2026-11-14T00:00:01.000Z' })
      expect(await lib.outbox()).toEqual([])
      // A pull of their older live row never brings it back.
      fakeApi({ 'GET /annotations/changes': feed(serverAnnotation(bookId, fileId, 1)) })
      await syncLibrary(lib, host())
      expect((await restoredEntry(lib)).highlights).toEqual([])
    })

    it('removal_PendingWhileAPullBringsItLive_StaysRemoved_DeletedOnPush', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.removeHighlight(HL)
      const calls = fakeApi({
        'GET /annotations/changes': feed(serverAnnotation(bookId, fileId, 2, { color: 'green' })),
        [`DELETE /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 3, { deletedAt: '2026-11-14T00:00:01.000Z' }))],
      })
      await syncLibrary(lib, host())
      expect(writes(calls)).toEqual([`DELETE /annotations/${HL}`])
      expect((await restoredEntry(lib)).highlights).toEqual([])
    })

    it('removal_NeverOnTheServer_404_Done_NoPutOfIt', async () => {
      const { lib, bookId, fileId } = await seeded()
      await lib.removeHighlight(HL)
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`DELETE /annotations/${HL}`]: [{ status: 404, body: { code: 'not_found', message: 'not_found' } }],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}/reading-state`, `DELETE /annotations/${HL}`])
      expect(await lib.outbox()).toEqual([])
    })

    // #1312 review: a device that synced highlights before notes were kept.
    it('upgrade_RowsFromBeforeNotes_FeedReadAgainFromTheStart_TheirNoteKept_NeverClearedByAPush', async () => {
      const db = memoryDb()
      const old = createLocalLibrary(db)
      await old.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      const bookId = (await old.localBookId(SHA))!
      await old.writeEntry(SHA, entry(), newId)
      const fileId = (await old.book(bookId))!.file_id!
      fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
      })
      await syncLibrary(old, host())
      // The build before notes: no note columns, a cursor past the row (the web wrote a note on it since).
      db.raw.exec(`ALTER TABLE annotations DROP COLUMN note_known; ALTER TABLE annotations DROP COLUMN note_dirty; ALTER TABLE annotations DROP COLUMN note;
        DELETE FROM meta WHERE key = 'upgrade:notes'; INSERT OR REPLACE INTO meta (key, value) VALUES ('cursor:annotations', 'past-the-row')`)
      const lib = createLocalLibrary(db)
      // Recoloured on this device after the upgrade, before any pull: queued.
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      expect(await lib.cursor('annotations')).toBeNull()
      expect(await lib.annotation(HL)).toMatchObject({ note: null, note_known: 0 })
      // Not known: not in the notes an editor reads (it waits, Save off), never shown as "no note".
      expect(await lib.notes(SHA)).toEqual({ known: new Map(), unknown: new Set([HL]), deleted: new Set() })
      const theirs = serverAnnotation(bookId, fileId, 2, { noteText: 'from the web' })
      const calls = fakeApi({
        'GET /annotations/changes': feed(theirs),
        [`PUT /annotations/${HL}`]: [conflict('stale_revision', { revision: 2, current: theirs }), ok(serverAnnotation(bookId, fileId, 3, { color: 'green', noteText: 'from the web' }))],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      const puts = calls.filter((c) => c.method === 'PUT' && c.path === `/annotations/${HL}`).map((c) => [c.body.color, c.body.noteText])
      expect(puts.length).toBeGreaterThan(0)
      expect(puts.every(([, n]) => n === 'from the web')).toBe(true)
      expect(await lib.annotation(HL)).toMatchObject({ note: 'from the web', note_known: 1, revision: 3 })
      expect((await lib.notes(SHA)).known).toEqual(new Map([[HL, 'from the web']]))
    })

    it('upgrade_KilledBeforeItCommitted_RunsAtTheNextStart_Once_NeverOverANoteEditedHere', async () => {
      const db = memoryDb()
      const old = createLocalLibrary(db)
      await old.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      const bookId = (await old.localBookId(SHA))!
      await old.writeEntry(SHA, entry(), newId)
      const fileId = (await old.book(bookId))!.file_id!
      fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
      })
      await syncLibrary(old, host())
      await old.setNote(HL, 'edited here')
      // The columns are there, the upgrade's marker is not: the process died before the upgrade committed.
      db.raw.exec(`DELETE FROM meta WHERE key = 'upgrade:notes'; INSERT OR REPLACE INTO meta (key, value) VALUES ('cursor:annotations', 'c1')`)
      const lib = createLocalLibrary(db)
      expect(await lib.cursor('annotations')).toBeNull()
      // A note edited here is not unknown: never taken over by the pull, pushed as it is.
      expect(await lib.annotation(HL)).toMatchObject({ note: 'edited here', note_dirty: 1, note_known: 1 })
      const theirs = serverAnnotation(bookId, fileId, 2, { noteText: 'theirs' })
      const calls = fakeApi({
        'GET /annotations/changes': feed(theirs),
        [`PUT /annotations/${HL}`]: [conflict('stale_revision', { revision: 2, current: theirs }), ok(serverAnnotation(bookId, fileId, 3, { noteText: 'edited here' }))],
      })
      await syncLibrary(lib, host())
      expect(calls.filter((c) => c.method === 'PUT' && c.path === `/annotations/${HL}`).map((c) => c.body.noteText)).toEqual(['edited here', 'edited here'])
      // Done once: a later start keeps the cursor.
      db.raw.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('cursor:annotations', 'c2')`)
      expect(await createLocalLibrary(db).cursor('annotations')).toBe('c2')
    })

    it('wipe_TheNotesUpgradeMarkerStays_ARowSyncedAfterIsNeverMarkedUnknown_TheDevAliasTableDropped', async () => {
      const db = memoryDb()
      db.raw.exec('CREATE TABLE annotation_aliases (old TEXT PRIMARY KEY, new TEXT NOT NULL)')
      const lib = createLocalLibrary(db)
      await lib.setAccount('u1', false)
      await lib.wipe()
      const meta = (key: string) => db.raw.prepare('SELECT value FROM meta WHERE key = ?').get(key)
      expect(meta('upgrade:notes')).toBeTruthy()
      expect(await lib.owner()).toBeNull()
      expect(db.raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'annotation_aliases'`).get()).toBeUndefined()
      // A later start (after a sign-in pulled and pushed rows): the upgrade does not run again.
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      await lib.writeEntry(SHA, entry(), newId)
      db.raw.exec(`UPDATE annotations SET revision = 1; INSERT OR REPLACE INTO meta (key, value) VALUES ('cursor:annotations', 'c1')`)
      const next = createLocalLibrary(db)
      expect(await next.cursor('annotations')).toBe('c1')
      expect(await next.annotation(HL)).toMatchObject({ note_known: 1 })
    })

    it('pull_AQueuedRowNotKnownButEditedHere_ItsNoteKept', async () => {
      // Not a state the upgrade makes (it spares edited notes); the pull's own guard, pinned.
      const db = memoryDb()
      const lib = createLocalLibrary(db)
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      const bookId = (await lib.localBookId(SHA))!
      await lib.writeEntry(SHA, entry(), newId)
      const fileId = (await lib.book(bookId))!.file_id!
      await lib.setNote(HL, 'mine')
      db.raw.exec(`UPDATE annotations SET note_known = 0`)
      await lib.applyAnnotations([serverAnnotation(bookId, fileId, 2, { noteText: 'theirs' }) as never])
      expect(await lib.annotation(HL)).toMatchObject({ note: 'mine', note_dirty: 1 })
    })

    it('upgrade_ARowTheFeedNeverBrings_NotPushedUntilTheFeedWasReadToItsEnd', async () => {
      const db = memoryDb()
      const old = createLocalLibrary(db)
      await old.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      const bookId = (await old.localBookId(SHA))!
      await old.writeEntry(SHA, entry(), newId)
      const fileId = (await old.book(bookId))!.file_id!
      fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
      })
      await syncLibrary(old, host())
      db.raw.exec(`ALTER TABLE annotations DROP COLUMN note_known; ALTER TABLE annotations DROP COLUMN note_dirty; ALTER TABLE annotations DROP COLUMN note;
        DELETE FROM meta WHERE key = 'upgrade:notes'`)
      const lib = createLocalLibrary(db)
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'pink' }]), newId)
      // The sign-out push pulls nothing: the unknown row is not pushed (it would clear a server note), it stays queued.
      let calls = fakeApi({ [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 2, { color: 'pink' }))] })
      await pushBeforeSignOut('u1', false, 1000, () => lib)
      expect(calls.some((c) => c.method === 'PUT' && c.path === `/annotations/${HL}`)).toBe(false)
      expect(await lib.outbox()).toEqual([expect.objectContaining({ kind: 'annotation', target: HL })])
      // Read to its end without it: not on the server, so no note there to keep; pushed.
      calls = fakeApi({ [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 2, { color: 'pink' }))] })
      await syncLibrary(lib, host())
      expect(calls.filter((c) => c.method === 'PUT' && c.path === `/annotations/${HL}`).map((c) => c.body.noteText)).toEqual([null])
    })

    // #1312 review: the page keeps the old id until the next open; every way in (its stores, notes, removals) reaches the
    // re-keyed row through the library's in-memory map, recorded once the re-key committed.
    async function rekeyedWhile(during: (lib: LocalLibrary, newId: string) => Promise<unknown>) {
      const { lib, bookId, fileId } = await seeded()
      const NEW = '00000000-0000-4000-8000-0000000000ff'
      const flying = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [conflict('id_conflict')],
        [`PUT /annotations/${NEW}`]: [ok(serverAnnotation(bookId, fileId, 1, { id: NEW }), 201)],
      })
      const real = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === 'PUT' && String(url).endsWith(`/annotations/${NEW}`)) {
          expect(lib.realId(HL)).toBe(NEW)
          // The page's store, still under the old id: the new row's form, nothing new written.
          await lib.writeEntry(SHA, entry(pos, [highlight]), newId)
          await during(lib, HL)
        }
        return real(url, init)
      }))
      try {
        await syncLibrary(lib, host({ newId: () => NEW }))
      } finally {
        vi.unstubAllGlobals()
      }
      expect(flying.filter((c) => c.method === 'PUT' && c.path.startsWith('/annotations/')).map((c) => c.path)).toEqual([`/annotations/${HL}`, `/annotations/${NEW}`])
      expect(await lib.annotation(HL)).toBeNull()
      return { lib, bookId, fileId, NEW }
    }

    it('rekey_Twice_OldMidNew_EveryOldIdReachesTheRow', async () => {
      const { lib } = await seeded()
      const MID = '00000000-0000-4000-8000-0000000000aa', NEW = '00000000-0000-4000-8000-0000000000bb'
      await lib.rekeyAnnotation(HL, () => MID)
      await lib.rekeyAnnotation(MID, () => NEW)
      expect([lib.realId(HL), lib.realId(MID)]).toEqual([NEW, NEW])
      expect(await lib.setNote(HL, 'deep')).toBe(true)
      expect(await lib.annotation(NEW)).toMatchObject({ note: 'deep' })
      const n = await lib.notes(SHA)
      expect([n.known.get(HL), n.known.get(MID), n.known.get(NEW)]).toEqual(['deep', 'deep', 'deep'])
    })

    it('rekey_ATransactionThatFails_NoMappingKept', async () => {
      const { lib } = await seeded()
      const OTHER = '0b6a2c1e-1111-4222-8333-444455557777'
      await lib.writeEntry(SHA, entry(pos, [highlight, { ...highlight, id: OTHER, cfi: 'epubcfi(/6/16!/4/2/1:0)' }]), newId)
      // The new id is taken: the rename fails and rolls back, so the old id still names the row.
      await expect(lib.rekeyAnnotation(HL, () => OTHER)).rejects.toThrow()
      expect(lib.realId(HL)).toBe(HL)
      expect(await lib.annotation(HL)).not.toBeNull()
    })

    it('idConflict_ThePageStillOnTheOldId_ItsRecolourReachesTheNewRow_TheNextOpenCarriesTheNewId', async () => {
      const { lib, bookId, fileId, NEW } = await rekeyedWhile(async () => {})
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      expect(await lib.annotation(HL)).toBeNull()
      expect(JSON.parse((await lib.annotation(NEW))!.highlight)).toMatchObject({ id: NEW, color: 'green' })
      const calls = fakeApi({ [`PUT /annotations/${NEW}`]: [ok(serverAnnotation(bookId, fileId, 2, { id: NEW, color: 'green' }))] })
      await syncLibrary(lib, host())
      expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body.color])).toEqual([[`/annotations/${NEW}`, 'green']])
      expect(JSON.parse((await lib.readEntry(SHA))!).highlights.map((h: { id: string }) => h.id)).toEqual([NEW])
    })

    it('idConflict_ANoteMadeWhileTheRetriedWriteFlew_ReachesTheNewRow', async () => {
      const { lib, bookId, fileId, NEW } = await rekeyedWhile((l, id) => l.setNote(id, 'mine'))
      expect(await lib.annotation(NEW)).toMatchObject({ note: 'mine', note_dirty: 1 })
      const calls = fakeApi({ [`PUT /annotations/${NEW}`]: [ok(serverAnnotation(bookId, fileId, 2, { id: NEW, noteText: 'mine' }))] })
      await syncLibrary(lib, host())
      expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body.noteText])).toEqual([[`/annotations/${NEW}`, 'mine']])
    })

    // #1312 review: messages the page sent under the old id, arriving after the re-key.
    it('idConflict_ALateNoteAndALateRemovalUnderTheOldId_ReachTheNewRow', async () => {
      const { lib, bookId, fileId, NEW } = await rekeyedWhile(async () => {})
      expect(await lib.setNote(HL, 'late')).toBe(true)
      expect(await lib.annotation(NEW)).toMatchObject({ note: 'late', note_dirty: 1 })
      // Looked up by the page's (old) id as well as the row's: the editor and the sheet see it (#1312 review).
      const n = await lib.notes(SHA)
      expect([n.known.get(HL), n.known.get(NEW)]).toEqual(['late', 'late'])
      expect(await lib.removeHighlight(HL)).toBe(true)
      const del = fakeApi({ [`DELETE /annotations/${NEW}`]: [ok(serverAnnotation(bookId, fileId, 2, { id: NEW, deletedAt: '2026-11-14T00:00:01.000Z' }))] })
      await syncLibrary(lib, host())
      expect(writes(del)).toEqual([`DELETE /annotations/${NEW}`])
      expect((await lib.notes(SHA)).deleted).toEqual(new Set([NEW, HL]))
      // A wipe ends the map with the rows it named.
      await lib.wipe()
      expect(lib.realId(HL)).toBe(HL)
    })

    it('idConflict_ARemovalWhileTheRetriedWriteFlew_DeletesTheNewRow', async () => {
      const { lib, bookId, fileId, NEW } = await rekeyedWhile((l, id) => l.removeHighlight(id))
      const del = fakeApi({ [`DELETE /annotations/${NEW}`]: [ok(serverAnnotation(bookId, fileId, 2, { id: NEW, deletedAt: '2026-11-14T00:00:01.000Z' }))] })
      await syncLibrary(lib, host())
      expect(writes(del)).toEqual([`DELETE /annotations/${NEW}`])
    })

    it('notes_ABookPulledNotImportedYet_ItsNotesByItsBytes', async () => {
      const lib = createLocalLibrary(memoryDb())
      const B = '11111111-2222-4333-8444-555555555555', F = '66666666-7777-4888-8999-aaaaaaaaaaaa'
      fakeApi({
        'GET /library/changes': feed(serverBook(B, F, {}, { hasContent: true })),
        'GET /annotations/changes': feed(serverAnnotation(B, F, 1, { noteText: 'from the server' })),
      })
      await syncLibrary(lib, host())
      expect((await lib.notes(SHA)).known).toEqual(new Map([[HL, 'from the server']]))
    })

    it('notes_AHighlightJustStored_KnownWithNoNote_NeverWaitingForOne', async () => {
      const { lib } = await seeded()
      expect(await lib.notes(SHA)).toEqual({ known: new Map([[HL, null]]), unknown: new Set(), deleted: new Set() })
    })

    it('deviceHighlights_LiveOnesOfBooksHereWithTheirNotes_ARemovedOneGone', async () => {
      const { lib, bookId } = await seeded()
      await lib.setNote(HL, 'n')
      expect(await lib.deviceHighlights()).toEqual([{ id: HL, bookId, bookTitle: 'T', text: 'bright cold', color: 'yellow', note: 'n', at: expect.anything() }])
      expect(await lib.removeHighlight(HL)).toBe(true)
      expect(await lib.removeHighlight(HL)).toBe(false)
      expect(await lib.deviceHighlights()).toEqual([])
      // Tombstoned: a drawn one's editor closes (#1312 review).
      expect(await lib.notes(SHA)).toEqual({ known: new Map(), unknown: new Set(), deleted: new Set([HL]) })
    })

    it('removal_Refused500_KeptQueuedAndRemovedHere_RetriedNextPass', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.removeHighlight(HL)
      fakeApi({ [`DELETE /annotations/${HL}`]: [{ status: 500 }] })
      expect(await syncLibrary(lib, host())).toBe('failed')
      expect(await lib.outbox()).toEqual([expect.objectContaining({ kind: 'annotation', target: HL })])
      expect((await restoredEntry(lib)).highlights).toEqual([])
      const calls = fakeApi({ [`DELETE /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 2, { deletedAt: '2026-11-14T00:00:01.000Z' }))] })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`DELETE /annotations/${HL}`])
    })
  })

  it('aLegacyHighlight_ShowsAsAQuotation_NeverDrawnNeverSent', async () => {
    // #1195: the earlier reader's highlight (a textstack-anchor-v1 row) is listed by its text and note; nothing the
    // device does to it reaches the server.
    const { lib, bookId, fileId } = await synced()
    const ANCHOR = '0b6a2c1e-2222-4222-8333-444455556666'
    await lib.applyAnnotations([serverAnnotation(bookId, fileId, 3, {
      id: ANCHOR, selectedText: 'an older highlight', noteText: 'my note', color: 'green',
      locator: { version: 1, scheme: 'textstack-anchor-v1', value: { chapterId: 'c', startOffset: 1, endOffset: 5 } },
    }) as never])
    const e = await restoredEntry(lib)
    expect(e.highlights.map((h: { id: string }) => h.id)).toEqual([HL])
    expect(e.quotations).toEqual([{ id: ANCHOR, quotation: true, selectedText: 'an older highlight', color: 'green', at: Date.parse('2026-11-10T00:00:00Z') }])
    expect((await lib.notes(SHA)).known.get(ANCHOR)).toBe('my note')
    await lib.setNote(ANCHOR, 'edited')
    await lib.removeHighlight(ANCHOR)
    expect(await lib.outbox()).toEqual([])
    const calls = fakeApi({})
    expect(await syncLibrary(lib, host())).toBe('done')
    expect(writes(calls)).toEqual([])
  })

  describe('Delete Book on this device (#1189)', () => {
    const SESSION = { startedAt: '2026-11-24T10:00:00Z', endedAt: '2026-11-24T10:10:00Z', durationSeconds: 600, wordsRead: 900, startPercent: 0.4, endPercent: 0.5 }

    it('deleteOffline_SyncedBook_GoneWithItsWritesThenOneDeleteAndAPullDoesNotBringItBack', async () => {
      const { lib, bookId, fileId } = await synced()
      // Read further and a session ended, offline: queued, never sent.
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      await lib.addSession(SHA, SESSION, newId)
      const [session] = await lib.outbox('session')
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
      expect(await lib.removeBook(bookId)).toBe(SHA)
      expect(await lib.books()).toEqual([])
      expect([await lib.book(bookId), await lib.state(bookId), await lib.annotation(HL), await lib.session(session.target)]).toEqual([null, null, null, null])
      expect(await lib.outbox()).toEqual([{ kind: 'removal', target: bookId, gen: 1, failures: 0 }])
      await syncLibrary(lib, host())
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['removal'])
      // Back online: the server still lists the book live; the removal goes, the book does not come back.
      const calls = fakeApi({
        'GET /library/changes': feed(serverBook(bookId, fileId, {}, { hasContent: true })),
        'GET /reading/changes': feed(serverState(bookId, fileId, 1)),
        [`DELETE /books/${bookId}`]: [{ status: 204 }],
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`DELETE /books/${bookId}`])
      expect(await lib.books()).toEqual([])
      expect(await lib.outbox()).toEqual([])
      const after = fakeApi({})
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(after)).toEqual([])
    })

    // Its first push may be in flight when it is deleted: the removal is queued all the same; the server lacking it answers 404.
    it('delete_NeverSyncedBook_RowGoneRemovalQueued_404DropsIt', async () => {
      const { lib, bookId } = await seeded()
      expect(await lib.removeBook(bookId)).toBe(SHA)
      expect(await lib.book(bookId)).toBeNull()
      expect((await lib.outbox()).map((o) => `${o.kind}:${o.target}`)).toEqual([`removal:${bookId}`])
      const calls = fakeApi({ [`DELETE /books/${bookId}`]: [{ status: 404, body: { code: 'not_found', message: 'not_found' } }] })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`DELETE /books/${bookId}`])
      expect(await lib.outbox()).toEqual([])
    })

    // Review: a delete made as a guest follows the merge to the account's id, and an offline sign-out warns about it.
    it('delete_AsAGuestThenMerged_TheRemovalTargetsTheAccountsBook_SignOutCountsIt', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.removeBook(bookId)
      expect(await lib.signOutLoss()).toEqual({ books: 0, writes: 1 })
      await lib.adoptAccount('u1', { [bookId]: 'acct-book' }, { [fileId]: 'acct-file' }, 'acct')
      expect((await lib.outbox()).map((o) => `${o.kind}:${o.target}`)).toEqual(['removal:acct-book'])
    })

    it('delete_ServerAnswers404_EntryDropped', async () => {
      const { lib, bookId } = await synced()
      await lib.removeBook(bookId)
      const calls = fakeApi({ [`DELETE /books/${bookId}`]: [{ status: 404, body: { code: 'not_found', message: 'not_found' } }] })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`DELETE /books/${bookId}`])
      expect(await lib.outbox()).toEqual([])
    })

    it('delete_SameBytesOpenedAgainBeforeThePush_TheBookIsKept', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.removeBook(bookId)
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      const calls = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [ok(serverBook(bookId, fileId))] })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([])
      expect((await lib.books()).map((b) => b.id)).toEqual([bookId])
    })

    // #1596: a removal the server keeps refusing is listed not synced, as a stuck write is; Try again sends it again.
    it('removeBook_ServerKeepsRefusing_ListedNotSyncedWithTryAgain', async () => {
      const { lib, bookId } = await synced()
      await lib.removeBook(bookId)
      expect(await lib.books()).toEqual([])
      const calls = fakeApi({ [`DELETE /books/${bookId}`]: [{ status: 500, body: { code: 'internal', message: 'boom' } }] })
      for (let i = 0; i < MAX_FAILURES + 1; i++) await syncLibrary(lib, host())
      expect(writes(calls)).toHaveLength(MAX_FAILURES)
      expect((await lib.books()).map((b) => [b.id, b.title, b.local, b.deleted, b.notSynced])).toEqual([[bookId, 'T', false, true, CHANGES_NOT_SYNCED]])
      expect(await lib.book(bookId)).toBeNull()
      await tryAgainBook(lib, bookId, async () => {}, () => {})
      expect(await lib.books()).toEqual([])
      fakeApi({ [`DELETE /books/${bookId}`]: [{ status: 204 }] })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect([await lib.outbox(), await lib.books(), await lib.signOutLoss()]).toEqual([[], [], { books: 0, writes: 0 }])
    })

    // #1596: deleted while its first push asked the server for its bytes: the server's book is the one removed.
    it('removeBook_DuringTheFirstPushShaLookup_TheServersBookIsRemoved', async () => {
      const { lib, bookId } = await seeded()
      const S = 'aaaaaaaa-0000-4000-8000-000000000009'
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [ok(serverBook(S, 'aaaaaaaa-0000-4000-8000-00000000000a'))],
        [`DELETE /books/${S}`]: [{ status: 204 }],
      })
      const answer = globalThis.fetch
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (url.includes('/by-sha256/')) await lib.removeBook(bookId)
        return answer(url, init)
      })
      expect(await syncLibrary(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`DELETE /books/${S}`])
      expect([await lib.outbox(), await lib.books()]).toEqual([[], []])
    })

    // #1596: deleted while it downloaded: the bytes the retain moved in are deleted too, no orphan file.
    it('downloadBook_DeletedWhileItDownloads_TheRetainedFileIsRemoved', async () => {
      const lib = createLocalLibrary(memoryDb())
      const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
      fakeApi({ 'GET /library/changes': feed(serverBook(sid, 'aaaaaaaa-0000-4000-8000-000000000002', {}, { hasContent: true })) })
      await syncLibrary(lib, host())
      const remove = vi.fn()
      const storage = createHostStorage({ read: async () => null, move: async () => {}, exists: () => true, remove, copyIn: async () => {} }, newId, lib)
      const io = { fetch: async () => 'staging/dl.epub', retain: async () => void (await lib.removeBook(sid)), dropUnheld: storage.dropUnheld }
      expect(await downloadBook(lib, sid, io)).toBe(false)
      expect(remove).toHaveBeenCalledWith(`books/${SHA}.epub`)
      expect(await lib.books()).toEqual([])
    })

    // #1596: a server answer about a deleted book's file (file_replaced, an upload landing) never lists it again.
    it('setServerFile_DeletedBooksKeptRow_NotWritten_NotListedNorImportedInto', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.removeBook(bookId)
      await lib.setServerFile(bookId, serverFile(fileId, { hasContent: true }) as never)
      await lib.setHasContent(bookId)
      expect(await lib.books()).toEqual([])
      await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      expect(await lib.localBookId(SHA)).not.toBe(bookId)
    })

    // #1596: a position write in flight when the book is deleted keeps nothing of it.
    it('removeBook_WhileItsPositionWriteIsInFlight_NoStateKept', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))], [`DELETE /books/${bookId}`]: [{ status: 204 }] })
      const answer = globalThis.fetch
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (url.endsWith('/reading-state')) await lib.removeBook(bookId)
        return answer(url, init)
      })
      await syncLibrary(lib, host())
      expect(await lib.state(bookId)).toBeNull()
    })

    it('removeLocalBook_RetainedFileDeletedListRefreshedThenAPass', async () => {
      const { lib, bookId } = await synced()
      const order: string[] = []
      await removeLocalBook(lib, { remove: (name) => { order.push(`remove ${name}`) } }, bookId, async () => order.push('refresh'), () => order.push('sync'))
      expect(order).toEqual([`remove books/${SHA}.epub`, 'refresh', 'sync'])
    })
  })
})
