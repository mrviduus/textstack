/**
 * R6's DoD (#1038): the local library's sync client against the fake V2 API, on a real SQLite
 * (node:sqlite). Conflict tests: simultaneous edit, stale revision, reset, file_replaced, offline
 * queue replay (idempotent by client id / revision / own write), sign-out mid-sync (the shared
 * `whileCurrent` epoch guard), plus the pull merges, id re-keying, opt-in file sync and download.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initApi, V2UploadNotOnServer, type OpenReader } from '@textstack/shared'
import { resetV2ForTests, v2Store, V2UploadError } from '../v2'
import { CHANGES_NOT_SYNCED, createLocalLibrary, identityStep, wipeV2Library, type LocalLibrary, type PositionAction } from './localLibrary'
import { memoryDb } from './sqliteShim'
import { createV2Storage } from './hostStorage'
import { adoptV2LocalAccount, claimV2LibraryFor, downloadV2Book, MAX_FAILURES, pushV2BeforeSignOut, syncV2Library, tryAgainV2Book, type SyncHost } from './sync'
import {
  fakeApi as fakeV2, conflict, feed, resetMidCall, type Answer, type Call,
} from '../../../../../packages/shared/src/api/__tests__/fakeV2Api'

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))
vi.mock('../offlineDb', () => ({ dropReplacedUserBookFiles: async () => [] }))
vi.mock('../originalFileCache', () => ({ deleteOriginal: async () => {} }))

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
const EMPTY_FEEDS = { 'GET /library/changes': feed(), 'GET /reading/changes': feed(), 'GET /annotations/changes': feed() }
const fakeApi = (routes: Record<string, Answer[]>) => fakeV2({ 'GET /status': [ok({ maxPartBytes: 1024 })], ...EMPTY_FEEDS, ...routes }, V2)
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)

/** Calls of `clearFiles` given to `claimV2LibraryFor` / `wipeV2Library` (#1070). */
let cleared = 0

function host(extra: Partial<SyncHost> = {}): SyncHost & { owed: PositionAction[] } {
  const owed: PositionAction[] = []
  return { userId: 'u1', newId, reader: () => null, onPosition: (a) => owed.push(a), guest: false, owed, ...extra }
}

/** A local book with a position and a highlight, never synced. */
async function seeded(): Promise<{ lib: LocalLibrary; bookId: string; fileId: string }> {
  const lib = createLocalLibrary(memoryDb())
  const bookId = await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
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
  expect(await syncV2Library(s.lib, host())).toBe('done')
  return s
}

const restoredEntry = async (lib: LocalLibrary) => JSON.parse((await lib.readEntry(SHA))!)

describe('V2 local library sync (R6)', () => {
  beforeEach(async () => {
    resetV2ForTests()
    n = 0
    cleared = 0
    initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sync_V2Off_DoesNothingAndKeepsTheOutbox', async () => {
    const { lib } = await seeded()
    const calls = fakeV2({ 'GET /status': [{ status: 404 }] }, V2)
    expect(await syncV2Library(lib, host())).toBe('off')
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
    expect(await syncV2Library(lib, host())).toBe('done')
    expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL}`])
    const [imp, st, an] = calls.filter((c) => c.method === 'PUT')
    expect(imp.body).toEqual({ title: 'T', author: null, file: { id: fileId, sha256: SHA, byteSize: 10, originalName: 'b.epub', format: 'epub' } })
    expect(st.body).toMatchObject({ expectedRevision: null, fileId, bookFraction: 0.41, currentLocator: { scheme: 'epub-cfi', value: CFI, quote: pos.quote } })
    expect(an.body).toMatchObject({ expectedRevision: null, bookId, fileId, selectedText: 'bright cold', color: 'yellow', locator: { value: CFI, quote: 'bright' } })
    expect(await lib.outbox()).toEqual([])
    expect(await lib.state(bookId)).toMatchObject({ revision: 1, revision_file_id: fileId })
    expect(await lib.annotation(HL)).toMatchObject({ revision: 1 })
    // Cursors stored per feed (null from the fake: a full pull again next time).
    expect(calls.filter((c) => c.path.endsWith('/changes')).map((c) => c.path)).toEqual(['/library/changes', '/reading/changes', '/annotations/changes'])
  })

  it('sync_NextPositionAfterASync_NamesTheRevisionLastSeen', async () => {
    const { lib, bookId, fileId } = await synced()
    await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 1000 }), newId)
    const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))] })
    await syncV2Library(lib, host())
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ expectedRevision: 1, bookFraction: 0.5 })
    expect(await lib.state(bookId)).toMatchObject({ revision: 2 })
  })

  describe('offline queue replay (idempotent by client id, revision, own write)', () => {
    it('replay_ImportLandedButAnswerLost_ShaLookupAdoptsNoSecondImport', async () => {
      const { lib, bookId, fileId } = await seeded()
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
      expect(await syncV2Library(lib, host())).toBe('off') // the probe never reached the server
      resetV2ForTests()
      const first = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [{ status: 502 }],
      })
      expect(await syncV2Library(lib, host())).toBe('failed')
      expect(writes(first)).toEqual([`PUT /books/${bookId}`])
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['book', 'state', 'annotation'])
      // The import had landed: the replay finds the bytes and takes the server's (same) ids.
      const second = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [ok(serverBook(bookId, fileId))],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1))],
      })
      expect(await syncV2Library(lib, host())).toBe('done')
      expect(writes(second)).toEqual([`PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL}`])
      expect(await lib.outbox()).toEqual([])
    })

    it('replay_StateAndAnnotationLandedAnswersLost_OwnWritesAdoptedNoDuplicate', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.6, at: NOW - 500 }, [{ ...highlight, color: 'green' }]), newId)
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: [{ status: 503, body: { code: 'v2_unavailable', message: 'paused' } }] })
      expect(await syncV2Library(lib, host())).toBe('failed')
      // Both writes had landed (revision 2): the replay is told stale_revision with its own row as current.
      const sentState = { ...serverState(bookId, fileId, 2), bookFraction: 0.6, clientRecordedAt: new Date(NOW - 500).toISOString() }
      const calls = fakeApi({
        [`PUT /books/${bookId}/reading-state`]: [conflict('stale_revision', { revision: 2, current: sentState })],
        [`PUT /annotations/${HL}`]: [conflict('stale_revision', { revision: 2, current: serverAnnotation(bookId, fileId, 2, { color: 'green' }) })],
      })
      expect(await syncV2Library(lib, host())).toBe('done')
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
      await syncV2Library(lib, host())
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
      expect(await syncV2Library(lib, host())).toBe('done')
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
      expect(await syncV2Library(lib, host())).toBe('done')
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${nid}`, `PUT /books/${nid}/reading-state`, `PUT /annotations/${HL}`])
      expect(calls.find((c) => c.path === `/books/${nid}`)?.body.file.id).toBe(nfid)
      expect(await lib.outbox()).toEqual([])
    })

    // QA #1038: an un-coded failure of one entry (a 500 from a CHECK the validation missed) used to
    // end the pass, and the fixed outbox order starved every later entry. Each entry is now isolated.
    it('push_OnePoisonedBookEntry_LaterEntriesStillPushed', async () => {
      const { lib, bookId } = await seeded()
      const SHA2 = 'cd'.repeat(32)
      const other = await lib.addOpened({ sha256: SHA2, size: 10, title: 'U', author: '', originalName: 'u.epub', format: 'epub' }, newId)
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`GET /books/by-sha256/${SHA2}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [{ status: 500 }],
        [`PUT /books/${other}`]: [ok(serverBook(other, (await lib.book(other))!.file_id!, {}, { sha256: SHA2 }), 201)],
      })
      for (let i = 0; i < 3; i++) await syncV2Library(lib, host())
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
      await syncV2Library(lib, h)
      expect(writes(calls)).toEqual([`PUT /books/${bookId}/reading-state`])
      expect((await restoredEntry(lib)).position).toMatchObject({ quote: 'theirs', fraction: 0.55 })
      expect(await lib.state(bookId)).toMatchObject({ revision: 4 })
      expect(h.owed).toEqual([expect.objectContaining({ bookId, action: 'adopt' })])
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
      const h = host({ reader: (id) => (id === bookId ? reader : null) })
      await syncV2Library(lib, h)
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
      await syncV2Library(lib, h)
      expect(h.owed.map((o) => o.action)).toEqual(['move'])
      expect((await restoredEntry(lib)).position.quote).toBe('theirs')
    })

    it('pull_TheirsNewerInAnotherSpineItem_PromptNotMoved', async () => {
      const { lib, bookId, fileId } = await synced()
      fakeApi({ 'GET /reading/changes': feed(theirs(bookId, fileId, 3, NOW - 1000, 'epubcfi(/6/20!/4/2/1:0)')) })
      const h = host({ reader: () => ({ restoreApplied: true, moved: false, index: 6 }) })
      await syncV2Library(lib, h)
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
      await syncV2Library(lib, host())
      expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.body.expectedRevision, c.body.bookFraction])).toEqual([[1, 0.5], [7, 0.5]])
      expect(await lib.state(bookId)).toMatchObject({ revision: 8 })
    })

    it('reset_RestartedElsewhere_PositionWrittenAgainOnTheNewRevision', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const calls = fakeApi({
        [`PUT /books/${bookId}/reading-state`]: [conflict('reset', { revision: 9, current: serverState(bookId, fileId, 9, { resetRevision: 9 }) }), ok(serverState(bookId, fileId, 10))],
      })
      await syncV2Library(lib, host())
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.expectedRevision)).toEqual([1, 9])
      expect(await lib.outbox()).toEqual([])
    })

    it('fileReplaced_ReplacedOnAnotherDevice_WriteDroppedOldCopyKeepsReading', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const replacement = serverFile('7c1e0000-0000-4000-8000-000000000001', { sha256: 'cd'.repeat(32), hasContent: true })
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: [conflict('file_replaced', { fileId: replacement.id, current: null, currentFile: replacement })] })
      await syncV2Library(lib, host())
      expect(await lib.outbox()).toEqual([])
      expect(await lib.book(bookId)).toMatchObject({ file_id: fileId, server_file_id: replacement.id, has_content: 1 })
      expect((await restoredEntry(lib)).position.fraction).toBe(0.5)
      // The next save on the old copy is never sent.
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.6, at: NOW - 50 }), newId)
      const calls = fakeApi({})
      await syncV2Library(lib, host())
      expect(writes(calls)).toEqual([])
    })

    it('staleRevision_NoCurrentRow_RewrittenAsAFirstWrite', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const calls = fakeApi({
        [`PUT /books/${bookId}/reading-state`]: [conflict('stale_revision', { revision: 7, current: null }), ok(serverState(bookId, fileId, 8))],
      })
      await syncV2Library(lib, host())
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.expectedRevision)).toEqual([1, null])
      expect(await lib.state(bookId)).toMatchObject({ revision: 8 })
      expect(await lib.outbox()).toEqual([])
    })

    it('unknownFile_ServerLostTheBook_BookPushedFirstStateKept', async () => {
      const { lib, bookId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: [conflict('unknown_file')] })
      await syncV2Library(lib, host())
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
        await syncV2Library(lib, h)
        const restored = (await restoredEntry(lib)).position
        expect(restored).toEqual({ fraction: 0.7, at })
        expect(h.owed).toEqual([expect.objectContaining({ action: 'adopt', position: { fraction: 0.7, at } })])
        // The page opens the book and restores it with no movement: it sends back what it was given.
        await lib.writeEntry(SHA, entry(restored), newId)
        expect(await lib.outbox()).toEqual([])
        // The next pass (the same revision echoed) owes nothing and writes nothing.
        const calls = fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, at)) })
        const again = host({ reader: () => ({ restoreApplied: true, moved: false, index: 1 }) })
        await syncV2Library(lib, again)
        expect(writes(calls)).toEqual([])
        expect(again.owed).toEqual([])
      })

      it('pull_NewerStateWhileUnmovedOnAFractionLanding_PromptedNoWrite', async () => {
        // Landed by fraction at rev 3, not moved since: rev 4 from another device is offered, never a silent move
        // (#1187 round 3: the host's moved flag is not guard enough). The landing stays here.
        const { lib, bookId, fileId } = await synced()
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, NOW - 2000)) })
        await syncV2Library(lib, host())
        await lib.writeEntry(SHA, entry((await restoredEntry(lib)).position), newId)
        const calls = fakeApi({ 'GET /reading/changes': feed({ ...transitional(bookId, fileId, 4, NOW - 1000), bookFraction: 0.8 }) })
        const h = host({ reader: () => ({ restoreApplied: true, moved: false, index: 1 }) })
        await syncV2Library(lib, h)
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
        await syncV2Library(lib, h)
        expect(h.owed.map((o) => o.action)).toEqual(['prompt'])
        expect((await restoredEntry(lib)).position).toMatchObject({ cfi: CFI, quote: pos.quote })
        expect(await lib.state(bookId)).toMatchObject({ revision: 3 })
      })

      it('pull_TransitionalOlderThanLocal_LocalCfiKeptRevisionTaken', async () => {
        const { lib, bookId, fileId } = await synced()
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, pos.at - 1000)) })
        const h = host()
        await syncV2Library(lib, h)
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
        await syncV2Library(lib, h)
        expect(h.owed.map((o) => o.action)).toEqual(['prompt'])
        const landed = { cfi: 'epubcfi(/6/20!/4/2/1:0)', quote: 'where it landed', index: 9, fraction: 0.7, at: NOW }
        await lib.writeEntry(SHA, entry(landed), newId)
        expect((await lib.outbox()).map((o) => o.kind)).toEqual(['state'])
        const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 4))] })
        await syncV2Library(lib, host())
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
        await syncV2Library(lib, host())
        expect(writes(quiet)).toEqual([])
        await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.72, at: NOW - 1000 }), newId)
        const next = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))] })
        await syncV2Library(lib, host())
        expect(next.find((c) => c.method === 'PUT')?.body).toMatchObject({ expectedRevision: 1, bookFraction: 0.72, currentLocator: { scheme: 'epub-cfi', value: CFI } })
        expect(await lib.outbox()).toEqual([])
      })

      it('pull_TransitionalPromptedOnce_SameRevisionPulledAgain_NoSecondPrompt', async () => {
        const { lib, bookId, fileId } = await synced()
        const reader = () => ({ restoreApplied: true, moved: false, index: 6 })
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, NOW - 1000)) })
        const h = host({ reader })
        await syncV2Library(lib, h)
        expect(h.owed.map((o) => o.action)).toEqual(['prompt'])
        const calls = fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, NOW - 1000)) })
        const again = host({ reader })
        await syncV2Library(lib, again)
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
        await syncV2Library(lib, h)
        expect(h.owed).toEqual([])
        expect((await restoredEntry(lib)).position).toEqual({ fraction: 0.7, at })
        expect(await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)).toBe(sid)
        const restored = (await restoredEntry(lib)).position
        expect(restored).toEqual({ fraction: 0.7, at })
        await lib.writeEntry(SHA, entry(restored, []), newId)
        expect(await lib.outbox()).toEqual([])
        const calls = fakeApi({ 'GET /reading/changes': feed(transitional(sid, sfid, 3, at)) })
        await syncV2Library(lib, host({ reader: () => ({ restoreApplied: true, moved: false, index: 1 }) }))
        expect(writes(calls)).toEqual([])
      })

      it('fractionPosition_MergeMapReKeyThenAnotherAccount_KeptForTheAccountRefusedForAnotherNeverPushed', async () => {
        const { lib, bookId, fileId } = await synced()
        const at = NOW - 1000
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, at)) })
        await syncV2Library(lib, host())
        await adoptV2LocalAccount('u1', 'acct', { books: { [bookId]: 'acct-book' }, files: { [fileId]: 'acct-file' } }, () => lib)
        expect((await restoredEntry(lib)).position).toEqual({ fraction: 0.7, at })
        expect(await lib.state('acct-book')).toMatchObject({ revision: 3, revision_file_id: 'acct-file' })
        let calls = fakeApi({})
        await syncV2Library(lib, host({ userId: 'acct' }))
        expect(writes(calls)).toEqual([])
        calls = fakeApi({})
        // Another account's pass is refused (#1070 rule D): kept here, never pushed.
        expect(await syncV2Library(lib, host({ userId: 'someone-else' }))).toBe('refused')
        expect((await restoredEntry(lib)).position).toEqual({ fraction: 0.7, at })
        expect(writes(calls).filter((w) => w.endsWith('/reading-state'))).toEqual([])
      })
    })

    describe('a CBZ page (page-name, #1188)', () => {
      const cbzPage = { cfi: 'epubcfi(/6/4)', page: 'Vol 1/p02.jpg', index: 1, fraction: 0.5, at: NOW - 1000 }
      const pageName = { version: 1, scheme: 'page-name', value: { page: 'Vol 1/p02.jpg', index: 1 } }
      async function cbzBook() {
        const lib = createLocalLibrary(memoryDb())
        const bookId = await lib.addOpened({ sha256: SHA, size: 10, title: 'C', author: '', originalName: 'c.cbz', format: 'cbz' }, newId)
        return { lib, bookId, fileId: (await lib.book(bookId))!.file_id! }
      }

      it('cbzPosition_Sent_AsPageNameWithEntryNameAndIndex', async () => {
        const { lib, bookId, fileId } = await cbzBook()
        await lib.writeEntry(SHA, entry(cbzPage, []), newId)
        const calls = fakeApi({
          [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId, {}, { format: 'cbz' }), 201)],
          [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1, { currentLocator: pageName, bookFraction: 0.5 }))],
        })
        await syncV2Library(lib, host())
        expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}/reading-state`])
        expect(calls.find((c) => c.path.endsWith('/reading-state'))!.body).toMatchObject({ expectedRevision: null, fileId, currentLocator: pageName, bookFraction: 0.5 })
        expect(await lib.outbox()).toEqual([])
        expect(await lib.state(bookId)).toMatchObject({ revision: 1 })
      })

      it('pull_PageNameNewerBookNotOpen_ImagePositionRestoredNoWriteBack', async () => {
        const { lib, bookId, fileId } = await cbzBook()
        fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId, {}, { format: 'cbz' }), 201)] })
        await syncV2Library(lib, host())
        const at = NOW - 1000
        fakeApi({ 'GET /reading/changes': feed(serverState(bookId, fileId, 3, { currentLocator: pageName, bookFraction: 0.5, clientRecordedAt: new Date(at).toISOString() })) })
        const h = host()
        await syncV2Library(lib, h)
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
        await syncV2Library(lib, host())
        expect(calls.find((c) => c.path.endsWith('/reading-state'))!.body).toMatchObject({ fileId, currentLocator: pageName, bookFraction: 0.5 })
      })

      it('pageKeyTheServerRefuses_NotSentAndSaidSoWithoutTheKey', async () => {
        const { lib, bookId } = await synced()
        await lib.writeEntry(SHA, entry({ ...fixedPage, page: 'x'.repeat(600) }), newId)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const calls = fakeApi({})
        await syncV2Library(lib, host())
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
        await syncV2Library(lib, host())
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
      await syncV2Library(lib, host())
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
      await syncV2Library(lib, host())
      expect((await restoredEntry(lib)).highlights[0].color).toBe('red')
      expect(await lib.outbox()).toEqual([])
    })

    it('deleted_TombstoneOnTheServer_DeletedHereAndNeverRecreated', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      fakeApi({ [`PUT /annotations/${HL}`]: [conflict('deleted', { revision: 4, current: serverAnnotation(bookId, fileId, 4, { deletedAt: '2026-11-10T01:00:00Z' }) })] })
      await syncV2Library(lib, host())
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
      await syncV2Library(lib, host())
      expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.body.expectedRevision, c.body.color])).toEqual([[1, 'green'], [3, 'green']])
      expect((await restoredEntry(lib)).highlights[0].color).toBe('green')
    })

    it('unknownFile_AnnotationOnABookTheServerLost_BookPushedFirstHighlightKept', async () => {
      const { lib } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      fakeApi({ [`PUT /annotations/${HL}`]: [conflict('unknown_file')] })
      await syncV2Library(lib, host())
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['book', 'annotation'])
    })

    it('pull_TombstoneWithAQueuedEdit_TombstoneWins', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      const calls = fakeApi({ 'GET /annotations/changes': feed(serverAnnotation(bookId, fileId, 4, { deletedAt: '2026-11-10T01:00:00Z' })) })
      await syncV2Library(lib, host())
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
      await syncV2Library(lib, host())
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
      await syncV2Library(lib, host())
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
      await syncV2Library(lib, host())
      const mine = { ...highlight, id: '0b6a2c1e-1111-4222-8333-444455557777', cfi: CFI2, index: 7, quote: 'grey', selectedText: 'grey dawn' }
      await lib.writeEntry(SHA, entry(pos, [highlight, mine]), newId)
      expect((await lib.outbox()).map((o) => o.target)).toContain(mine.id)
      expect(await lib.annotation(mine.id)).toMatchObject({ book_id: bookId })
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
      await syncV2Library(lib, host())
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
      await syncV2Library(lib, host())
      expect(await lib.books()).toEqual([expect.objectContaining({ id: sid, local: false, sha256: SHA })])
      const io = { fetch: vi.fn(async () => 'staging/dl.epub'), retain: vi.fn(async () => {}) }
      expect(await downloadV2Book(lib, sid, io)).toBe(true)
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
      await syncV2Library(lib, host())
      expect(await lib.cursor('library')).toBe('c1')
      fakeApi({})
      await syncV2Library(lib, host())
      const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u))
      expect(urls.find((u) => u.includes('/library/changes'))).toContain('cursor=c1')
    })

    // QA #1038: the rows and the cursor were two queue jobs, so a page that failed to apply still
    // advanced the cursor and its rows were skipped for good. Now one transaction.
    it('pull_PageFailsToApply_CursorNotAdvanced', async () => {
      const lib = createLocalLibrary(memoryDb())
      const bad = { ...serverBook('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'), title: null } // title NOT NULL
      fakeApi({ 'GET /library/changes': [ok({ items: [bad], cursor: 'c1', hasMore: false })] })
      expect(await syncV2Library(lib, host())).toBe('failed')
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
      await syncV2Library(lib, h)
      expect(h.owed).toEqual([])
    })
  })

  describe('PDF positions: pdf-page, never a CFI (#1128 S5)', () => {
    const page = (n: number, at = NOW - 60_000) => ({ page: n, index: n - 1, fraction: n / 10, at })
    const pdfState = (bookId: string, fileId: string, revision: number, n: number, at: number) =>
      serverState(bookId, fileId, revision, { currentLocator: { version: 1, scheme: 'pdf-page', value: { page: n } }, bookFraction: n / 10, clientRecordedAt: new Date(at).toISOString() })
    /** A local PDF with a page position, pushed once: the server knows it, its state at revision 1. */
    async function syncedPdf() {
      const lib = createLocalLibrary(memoryDb())
      const bookId = await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.pdf', format: 'pdf' }, newId)
      await lib.writeEntry(SHA, entry(page(3), []), newId)
      const fileId = (await lib.book(bookId))!.file_id!
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId, {}, { format: 'pdf', originalName: 'b.pdf' }), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(pdfState(bookId, fileId, 1, 3, NOW - 60_000))],
      })
      expect(await syncV2Library(lib, host())).toBe('done')
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
      await syncV2Library(lib, host())
      expect(next.find((c) => c.method === 'PUT')?.body).toMatchObject({ expectedRevision: 1, currentLocator: { scheme: 'pdf-page', value: { page: 5 } } })
      expect(await lib.state(bookId)).toMatchObject({ revision: 2 })
      expect(await lib.outbox()).toEqual([])
    })

    it('push_CfiPositionOnAPdf_NeverPushed_Dropped', async () => {
      const { lib, bookId } = await syncedPdf()
      // The page never builds one for a PDF; a stored one (another shape, a bug) must still never reach the server.
      await lib.writeEntry(SHA, entry({ ...pos, at: NOW - 1000 }), newId)
      const calls = fakeApi({})
      await syncV2Library(lib, host())
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
      await syncV2Library(lib, h)
      expect((await restoredEntry(lib)).position).toEqual({ page: 9, index: 8, fraction: 0.9, at: NOW - 1000 })
      expect(await lib.state(bookId)).toMatchObject({ revision: 3 })
      expect(h.owed).toEqual([expect.objectContaining({ bookId, action: 'adopt', position: { page: 9, index: 8, fraction: 0.9, at: NOW - 1000 } })])
    })

    it('pull_PdfPageOnTheOpenPage_MovedSilently_OtherPage_Prompted', async () => {
      const { lib, bookId, fileId } = await syncedPdf()
      fakeApi({ 'GET /reading/changes': feed(pdfState(bookId, fileId, 3, 3, NOW - 1000)) })
      const same = host({ reader: () => ({ restoreApplied: true, moved: false, index: 2 }) })
      await syncV2Library(lib, same)
      expect(same.owed.map((o) => o.action)).toEqual(['move'])
      fakeApi({ 'GET /reading/changes': feed(pdfState(bookId, fileId, 4, 8, NOW - 500)) })
      const other = host({ reader: () => ({ restoreApplied: true, moved: false, index: 2 }) })
      await syncV2Library(lib, other)
      expect(other.owed.map((o) => o.action)).toEqual(['prompt'])
    })

    it('pull_TransitionalStateOnAPdf_NoFractionFallback_PageKept', async () => {
      const { lib, bookId, fileId } = await syncedPdf()
      const transitional = serverState(bookId, fileId, 3, { currentLocator: { version: 1, scheme: 'textstack-position-v1', value: { chapterSlug: 'x', chapterFraction: 0.5 } }, bookFraction: 0.7, clientRecordedAt: new Date(NOW - 1000).toISOString() })
      fakeApi({ 'GET /reading/changes': feed(transitional) })
      const h = host()
      await syncV2Library(lib, h)
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
        resetV2ForTests()
        const lib = createLocalLibrary(memoryDb())
        fakeApi({
          'GET /library/changes': feed(serverBook(sid, sfid, {}, { hasContent: true, format: 'pdf', originalName: 'b.pdf' })),
          'GET /reading/changes': feed(state),
        })
        await syncV2Library(lib, host())
        expect(await downloadV2Book(lib, sid, io)).toBe(true)
        expect((await restoredEntry(lib)).position, state.currentLocator.scheme).toEqual(expected)
      }
    })

    it('androidHost_ServerOnlyPdf_DownloadOpenTurn_RestoresPullAndPushesPdfPageOnItsRevision', async () => {
      // R7 (#1039), the dev route's calls in order: pull, download on demand, open (restore, addOpened
      // with the page's `format`), a page turn's `store`, the next pass.
      const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
      const sfid = 'aaaaaaaa-0000-4000-8000-000000000002'
      const lib = createLocalLibrary(memoryDb())
      const files = { read: async () => null, move: async () => {}, exists: () => true, remove: () => {}, copyIn: async () => {} }
      const storage = createV2Storage(files, newId, lib)
      fakeApi({
        'GET /library/changes': feed(serverBook(sid, sfid, {}, { hasContent: true, format: 'pdf', originalName: 'b.pdf' })),
        'GET /reading/changes': feed(pdfState(sid, sfid, 3, 4, NOW - 1000)),
      })
      expect(await syncV2Library(lib, host())).toBe('done')
      expect((await storage.books()).map((b) => [b.id, b.local])).toEqual([[sid, false]])
      expect(await downloadV2Book(lib, sid, { fetch: async () => 'staging/dl.epub', retain: async () => {} })).toBe(true)
      // What the host hands `restore`: the other device's page.
      expect(JSON.parse((await storage.readStore(SHA))!).position).toEqual({ page: 4, index: 3, fraction: 0.4, at: NOW - 1000 })
      const { bookId } = await storage.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.pdf', format: 'pdf' }, null)
      expect(bookId).toBe(sid)
      await storage.writeStore(SHA, entry(page(7, NOW - 100), []))
      const calls = fakeApi({ [`PUT /books/${sid}/reading-state`]: [ok(pdfState(sid, sfid, 4, 7, NOW - 100))] })
      expect(await syncV2Library(lib, host())).toBe('done')
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
      const result = await resetMidCall(() => v2Store.reset(), {
        'GET /status': ok({ maxPartBytes: 1024 }),
        'GET /library/changes': feed()[0], 'GET /reading/changes': feed()[0], 'GET /annotations/changes': feed()[0],
        [`GET /books/by-sha256/${SHA}`]: { status: 404 },
        [`PUT /books/${bookId}`]: ok(serverBook(bookId, fileId), 201),
      }, () => syncV2Library(lib, host()), `/books/${bookId}`)
      expect(result).toBe('dropped')
      expect(await lib.book(bookId)).toMatchObject({ server_file_id: null })
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['book', 'state', 'annotation'])
    })

    it('signOutDuringPull_FeedAndCursorNotKept', async () => {
      const lib = createLocalLibrary(memoryDb())
      const result = await resetMidCall(() => v2Store.reset(), {
        'GET /status': ok({ maxPartBytes: 1024 }),
        'GET /library/changes': { status: 200, body: { items: [serverBook('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', {}, { hasContent: true })], cursor: 'c1', hasMore: false } },
      }, () => syncV2Library(lib, host()), '/library/changes')
      expect(result).toBe('dropped')
      expect(await lib.books()).toEqual([])
      expect(await lib.cursor('library')).toBeNull()
    })

    it('signOutDuringA409_ConflictHandlingWritesNothing', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 30_000 }), newId)
      const result = await resetMidCall(() => v2Store.reset(), {
        'GET /status': ok({ maxPartBytes: 1024 }),
        'GET /library/changes': feed()[0], 'GET /reading/changes': feed()[0], 'GET /annotations/changes': feed()[0],
        [`PUT /books/${bookId}/reading-state`]: conflict('stale_revision', { revision: 4, current: serverState(bookId, fileId, 4, { clientRecordedAt: new Date(NOW).toISOString(), bookFraction: 0.9 }) }),
      }, () => syncV2Library(lib, host()), '/reading-state')
      expect(result).toBe('dropped')
      expect(await lib.state(bookId)).toMatchObject({ revision: 1 })
      expect((await restoredEntry(lib)).position.fraction).toBe(0.5)
    })

    const pushRoutes = (bookId: string, fileId: string) => ({
      'GET /status': ok({ maxPartBytes: 1024 }),
      'GET /library/changes': feed()[0], 'GET /reading/changes': feed()[0], 'GET /annotations/changes': feed()[0],
      [`PUT /books/${bookId}/reading-state`]: ok(serverState(bookId, fileId, 2)),
      [`PUT /annotations/${HL}`]: ok(serverAnnotation(bookId, fileId, 2, { color: 'green' })),
    })

    it('signOutDuringStatePush_AnswerNotLandedWriteStaysQueued', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const result = await resetMidCall(() => v2Store.reset(), pushRoutes(bookId, fileId), () => syncV2Library(lib, host()), '/reading-state')
      expect(result).toBe('dropped')
      expect(await lib.state(bookId)).toMatchObject({ revision: 1 })
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['state'])
    })

    it('signOutDuringAnnotationPush_AnswerNotLandedWriteStaysQueued', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry(pos, [{ ...highlight, color: 'green' }]), newId)
      const result = await resetMidCall(() => v2Store.reset(), pushRoutes(bookId, fileId), () => syncV2Library(lib, host()), `/annotations/${HL}`)
      expect(result).toBe('dropped')
      expect(await lib.annotation(HL)).toMatchObject({ revision: 1 })
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['annotation'])
    })

    it('signOutWhileAPulledStateApplies_NothingOwedToTheReader', async () => {
      const { lib, bookId, fileId } = await synced()
      const theirs = serverState(bookId, fileId, 3, { currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/14!/4/2/9:0)', quote: 'theirs' }, clientRecordedAt: new Date(NOW - 1000).toISOString() })
      fakeApi({ 'GET /reading/changes': feed(theirs) })
      const h = host({ reader: () => { v2Store.reset(); return { restoreApplied: true, moved: false, index: 6 } } })
      expect(await syncV2Library(lib, h)).toBe('dropped')
      expect(h.owed).toEqual([])
    })

    it('signOutDuringUpload_NoLaterBookSentNothingMarked', async () => {
      const { lib, bookId } = await synced()
      const SHA2 = 'cd'.repeat(32)
      const other = await lib.addOpened({ sha256: SHA2, size: 10, title: 'U', author: '', originalName: 'u.epub', format: 'epub' }, newId)
      const otherFile = (await lib.book(other))!.file_id!
      await lib.setServerFile(other, serverFile(otherFile, { sha256: SHA2 }) as never)
      await lib.done({ kind: 'book', target: other, gen: 1, failures: 0 })
      await lib.setFileSync(true)
      fakeApi({})
      const upload = vi.fn(async () => { v2Store.reset() })
      expect(await syncV2Library(lib, host({ upload }))).toBe('dropped')
      expect(upload).toHaveBeenCalledTimes(1)
      expect(await lib.book(bookId)).toMatchObject({ has_content: 0 })
      expect(await lib.book(other)).toMatchObject({ has_content: 0 })
    })

    it('signOutWhileADownloadIsRetained_BookNotMadeLocal', async () => {
      const lib = createLocalLibrary(memoryDb())
      const sid = 'aaaaaaaa-0000-4000-8000-000000000001'
      fakeApi({ 'GET /library/changes': feed(serverBook(sid, 'aaaaaaaa-0000-4000-8000-000000000002', {}, { hasContent: true })) })
      await syncV2Library(lib, host())
      const io = { fetch: vi.fn(async () => 'staging/dl.epub'), retain: vi.fn(async () => { v2Store.reset() }) }
      expect(await downloadV2Book(lib, sid, io)).toBe(false)
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
      v2Store.reset() // signed out: the epoch bump, then the wipe
      await wipeV2Library(lib, clear)
      expect(await lib.owner()).toBeNull()
      // A book added with no session (or an open finishing late) belongs to nobody.
      const late = await lib.addOpened({ sha256: 'ef'.repeat(32), size: 3, title: 'Late', author: '', originalName: 'l.epub', format: null }, newId)
      fakeApi({})
      expect(await syncV2Library(lib, host({ userId: 'u2' }))).toBe('done')
      expect(await lib.owner()).toEqual({ id: 'u2', guest: false })
      expect((await lib.books()).map((b) => b.id)).toEqual([late])
      expect(cleared).toBe(1)
    })

    // B: the another-account wipe is sign-in's.
    describe('claimV2LibraryFor (sign-in)', () => {
      it('claim_AnotherRealAccountsLibrary_WipedLossLogged', async () => {
        const { lib } = await withUnsent()
        const w = warnings()
        await claimV2LibraryFor('u2', () => lib, clear)
        expect(await lib.books()).toEqual([])
        expect(await lib.outbox()).toEqual([])
        expect(await lib.owner()).toBeNull()
        expect(cleared).toBe(1)
        expect(w.lines().filter((m) => m.includes('another account signed in'))).toEqual([expect.stringContaining('lost 1 book(s) and 0 change(s)')])
        w.restore()
      })

      it('claim_SameAccountGuestOwnedOrUnowned_NothingWiped', async () => {
        const { lib, bookId } = await withUnsent()
        await claimV2LibraryFor('u1', () => lib, clear)
        await lib.setAccount('g1', true)
        await claimV2LibraryFor('u2', () => lib, clear)
        expect((await lib.books()).map((b) => b.id)).toEqual([bookId])
        expect(cleared).toBe(0)
        const empty = createLocalLibrary(memoryDb())
        await claimV2LibraryFor('u2', () => empty, clear)
        expect(cleared).toBe(0)
      })

      it('claim_RowWipeFails_FilesAndOwnerKept_PassesStillRefused', async () => {
        const { lib, bookId } = await withUnsent()
        const broken = { ...lib, wipe: () => Promise.reject(new Error('disk busy')) }
        const w = warnings()
        await expect(claimV2LibraryFor('u2', () => broken, clear)).rejects.toThrow('disk busy')
        expect(cleared).toBe(0)
        expect(await lib.owner()).toEqual({ id: 'u1', guest: false })
        v2Store.reset()
        const calls = fakeApi({})
        expect(await syncV2Library(lib, host({ userId: 'u2' }))).toBe('refused')
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
        expect(await syncV2Library(s.lib, host({ userId: 'g1', guest: true }))).toBe('done')
        expect(await s.lib.owner()).toEqual({ id: 'g1', guest: true })
        await s.lib.writeEntry(SHA, entry({ ...pos, fraction: 0.8, at: NOW }), newId)
        return s
      }

      it('guestToAccount_AdoptThrows_RowsAsTheyWere_FirstPassCarriesThemToTheAccount', async () => {
        const { lib, bookId } = await guestLibrary()
        const broken = () => ({ ...lib, adoptAccount: () => Promise.reject(new Error('disk busy')) })
        await expect(adoptV2LocalAccount('g1', 'acct', { books: { [bookId]: 'acct-book' }, files: {} }, broken)).rejects.toThrow('disk busy')
        // A failed adopt leaves the rows as they were (AuthContext's comment).
        expect(await lib.owner()).toEqual({ id: 'g1', guest: true })
        expect((await lib.books()).map((b) => b.id)).toEqual([bookId])
        await claimV2LibraryFor('acct', () => lib, clear)
        expect(cleared).toBe(0)
        v2Store.reset()
        const calls = fakeApi({
          [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
          [`PUT /books/${bookId}`]: [ok(serverBook(bookId, (await lib.book(bookId))!.file_id!), 201)],
          [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, (await lib.book(bookId))!.file_id!, 1))],
        })
        // Two passes: the state asks for its book first (what the server told the guest is forgotten).
        for (let i = 0; i < 2; i++) await syncV2Library(lib, host({ userId: 'acct' }))
        expect(await lib.owner()).toEqual({ id: 'acct', guest: false })
        // The guest's book and its unsent position go to the account.
        expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}/reading-state`])
        expect((await restoredEntry(lib)).position.fraction).toBe(0.8)
      })

      it('guestToNewGuest_Carried', async () => {
        const { lib, bookId } = await guestLibrary()
        v2Store.reset()
        fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [{ status: 502 }] })
        await syncV2Library(lib, host({ userId: 'g2', guest: true }))
        expect(await lib.owner()).toEqual({ id: 'g2', guest: true })
        expect((await lib.books()).map((b) => b.id)).toEqual([bookId])
      })

      it('guestPromotedInPlace_SameId_RecordedAsAnAccount', async () => {
        const { lib } = await guestLibrary()
        fakeApi({})
        await syncV2Library(lib, host({ userId: 'g1', guest: false }))
        expect(await lib.owner()).toEqual({ id: 'g1', guest: false })
      })

      it('guestSignsIn_MergeMapRekeysTheLibraryCursorsClearedNoWipe', async () => {
        const { lib, bookId, fileId } = await synced()
        await lib.setAccount('u1', true)
        fakeApi({ 'GET /library/changes': [ok({ items: [], cursor: 'c1', hasMore: false })] })
        await syncV2Library(lib, host({ guest: true }))
        expect(await lib.cursor('library')).toBe('c1')
        await claimV2LibraryFor('acct', () => lib, clear)
        await adoptV2LocalAccount('u1', 'acct', { books: { [bookId]: 'acct-book' }, files: { [fileId]: 'acct-file' } }, () => lib)
        expect(await lib.owner()).toEqual({ id: 'acct', guest: false })
        expect(await lib.book('acct-book')).toMatchObject({ file_id: 'acct-file', server_file_id: 'acct-file' })
        expect(await lib.state('acct-book')).toMatchObject({ revision: 1, revision_file_id: 'acct-file' })
        expect(await lib.annotation(HL)).toMatchObject({ book_id: 'acct-book', file_id: 'acct-file' })
        expect(await lib.cursor('library')).toBeNull()
        await adoptV2LocalAccount('someone-else', 'x', undefined, () => lib)
        expect(await lib.account()).toBe('acct')
        fakeApi({})
        await syncV2Library(lib, host({ userId: 'acct' }))
        expect(cleared).toBe(0)
        expect((await lib.books()).map((b) => b.id)).toEqual(['acct-book'])
      })
    })

    // D: a pass never wipes.
    it('passForAnotherRealAccount_Refused_NothingPulledPushedRecordedNoWipeNoLoop', async () => {
      const { lib, bookId } = await withUnsent()
      const w = warnings()
      v2Store.reset() // the session expired (onAuthFailure: no wipe); u2's sign-in wipe did not run
      for (let i = 0; i < 2; i++) {
        const calls = fakeApi({})
        expect(await syncV2Library(lib, host({ userId: 'u2' }))).toBe('refused')
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
      v2Store.reset()
      const calls = fakeApi({
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))],
        [`PUT /annotations/${HL2.id}`]: [ok({ ...serverAnnotation(bookId, fileId, 1), id: HL2.id }, 201)],
      })
      await syncV2Library(lib, host())
      expect(writes(calls)).toEqual([`PUT /books/${bookId}/reading-state`, `PUT /annotations/${HL2.id}`])
    })

    // E: the stale-id race only refuses.
    it('staleUserIdAfterTheOwnerChanged_Refused_LibraryIntact', async () => {
      const { lib, bookId } = await withUnsent()
      await claimV2LibraryFor('u2', () => lib, clear) // u2 signs in: u1's library wiped
      const u2Book = await lib.addOpened({ sha256: 'ef'.repeat(32), size: 3, title: 'U2', author: '', originalName: 'u.epub', format: 'epub' }, newId)
      await lib.setAccount('u2')
      const w = warnings()
      // A pass asked between the epoch bump and the re-render: fresh epoch, the old user id.
      const calls = fakeApi({})
      expect(await syncV2Library(lib, host({ userId: 'u1' }))).toBe('refused')
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
      const first = syncV2Library(slow, host())
      const queued = syncV2Library(lib, host()) // a save's pass, waiting for the running one
      v2Store.reset() // sign-out: the epoch bump, then the wipe
      await lib.wipe()
      release()
      expect(await first).toBe('dropped')
      expect(await queued).toBe('dropped')
      expect(calls.filter((c) => c.path === '/library/changes')).toEqual([])
      expect(await lib.owner()).toBeNull() // never re-recorded on the wiped library
    })

    // H: sign-out pushes only, in its own slot.
    describe('pushV2BeforeSignOut', () => {
      it('push_OutboxOnlyNoPulls_OwnSlotWhileAReaderPassRuns', async () => {
        const { lib, bookId, fileId } = await withUnsent()
        const { release, slow } = gated(lib)
        fakeApi({})
        const readerPass = syncV2Library(slow, host()) // a reader screen's pass, held
        const calls = fakeApi({
          [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))],
          [`PUT /annotations/${HL2.id}`]: [ok({ ...serverAnnotation(bookId, fileId, 1), id: HL2.id }, 201)],
        })
        await pushV2BeforeSignOut('u1', false, 1000, () => lib)
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
        await pushV2BeforeSignOut('u1', false, 50, () => slow)
        expect(Date.now() - started).toBeLessThan(1000)
        release()
        await pushV2BeforeSignOut('u1', false, 1000, () => lib) // the held push ends; nothing left running
      })
    })
  })

  describe('file sync (opt-in)', () => {
    it('fileSync_OffByDefault_NoUpload_OnUploadsBooksTheServerLacks', async () => {
      const { lib, bookId } = await synced()
      const upload = vi.fn(async () => {})
      fakeApi({})
      await syncV2Library(lib, host({ upload }))
      expect(upload).not.toHaveBeenCalled()
      await lib.setFileSync(true)
      await syncV2Library(lib, host({ upload }))
      expect(upload).toHaveBeenCalledWith(expect.objectContaining({ id: bookId }), 1024, expect.any(Function))
      expect(await lib.book(bookId)).toMatchObject({ has_content: 1 })
      upload.mockClear()
      await syncV2Library(lib, host({ upload }))
      expect(upload).not.toHaveBeenCalled()
    })

    it('fileSync_ContentRemovedOrQuotaFull_NothingMoreSent', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.setFileSync(true)
      fakeApi({ 'GET /library/changes': feed(serverBook(bookId, fileId, {}, { contentRemovedAt: '2026-11-10T00:00:00Z' })) })
      const upload = vi.fn(async () => { throw new V2UploadError('quota_exceeded', { used: 1, limit: 1 }) })
      await syncV2Library(lib, host({ upload }))
      expect(upload).not.toHaveBeenCalled()
      fakeApi({ 'GET /library/changes': feed(serverBook(bookId, fileId)) })
      expect(await syncV2Library(lib, host({ upload }))).toBe('done')
      expect(upload).toHaveBeenCalledTimes(1)
      expect(await lib.book(bookId)).toMatchObject({ has_content: 0 })
    })

    it('fileSync_ServerBookNotTheOneKnown_NoUploadMarkedBookPushedAgain', async () => {
      const { lib, bookId } = await synced()
      await lib.setFileSync(true)
      fakeApi({})
      const upload = vi.fn(async () => { throw new V2UploadNotOnServer(bookId) })
      await syncV2Library(lib, host({ upload }))
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
      await syncV2Library(lib, host())
      // The page opens the picked bytes and asks for its entry before addOpened adopts the row.
      expect((await restoredEntry(lib)).position).toMatchObject({ cfi: CFI, fraction: 0.66 })
      expect(await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)).toBe(sid)
      expect((await restoredEntry(lib)).position).toMatchObject({ fraction: 0.66 })
    })

    it('invalidPayload_BookParked_ChildrenNeverReAskForIt_UntilTheBookChanges', async () => {
      const { lib, bookId } = await seeded()
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [conflict('invalid_payload', { field: 'title' }, 400)],
      })
      for (let i = 0; i < 3; i++) await syncV2Library(lib, host())
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
      const first = syncV2Library(lib, host())
      const second = syncV2Library(lib, host())
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
      const old = syncV2Library(lib, host())
      for (let i = 0; i < 20 && !held; i++) await new Promise((r) => setTimeout(r, 0))
      v2Store.reset() // signed out; another session asks for a sync while the old pass is in flight
      // The same account signing back in (another account's pass would be refused: #1070 rule D).
      const fresh = syncV2Library(lib, host())
      release()
      expect(await fresh).toBe('done')
      expect(await old).toBe('done') // both callers see the last pass's result
      expect(await lib.account()).toBe('u1')
    })

    it('download_BytesAnotherBookHereHolds_NoSecondLocalCopy', async () => {
      const { lib } = await synced()
      fakeApi({ 'GET /library/changes': feed(serverBook(sid, sfid, {}, { hasContent: true })) })
      await syncV2Library(lib, host())
      expect((await lib.books()).map((b) => b.local)).toEqual([true])
      const io = { fetch: vi.fn(async () => 'staging/x.epub'), retain: vi.fn(async () => {}) }
      expect(await downloadV2Book(lib, sid, io)).toBe(false)
      expect(io.fetch).not.toHaveBeenCalled()
    })

    it('adoptAccount_ThenItsPass_ForgetsNothing_ReplayChangesNothing', async () => {
      const { lib, bookId, fileId } = await synced()
      expect(await lib.adoptAccount('u1', { [bookId]: 'acct-book' }, { [fileId]: 'acct-file' }, 'acct')).toBe(true)
      fakeApi({})
      await syncV2Library(lib, host({ userId: 'acct' }))
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
      expect(await syncV2Library(lib, host())).toBe('failed')
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
    const passes = async (lib: LocalLibrary, count: number, h = host()) => { for (let i = 0; i < count; i++) await syncV2Library(lib, h) }
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
      expect(await syncV2Library(lib, host())).toBe('done')
      expect(pushCalls(next)).toEqual([])
      expect(warn).not.toHaveBeenCalled()
      // The next session tries it again.
      const fresh = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: E500 })
      await syncV2Library(lib, host({ retryFailed: true }))
      expect(writes(fresh)).toEqual([`PUT /books/${bookId}`])
      expect((await lib.outbox('book'))[0].failures).toBe(1)
    })

    it('outage_502OnEveryPutForNPasses_HealthyServerNewSession_EverythingPushedNoTryAgain', async () => {
      const { lib, bookId, fileId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }, [{ ...highlight, color: 'green' }]), newId)
      const SHA2 = 'cd'.repeat(32)
      const other = await lib.addOpened({ sha256: SHA2, size: 10, title: 'U', author: '', originalName: 'u.epub', format: 'epub' }, newId)
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
      expect(await syncV2Library(lib, host({ retryFailed: true }))).toBe('done')
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
      const running = syncV2Library(lib, host())
      void syncV2Library(lib, host({ retryFailed: true }))
      await syncV2Library(lib, host())
      await running
      expect(writes(calls)).toEqual([`PUT /books/${bookId}/reading-state`])
      expect(await lib.outbox()).toEqual([])
    })

    it('staleRevision_InPassRetryExhausted_CountedAsAFailedAttempt', async () => {
      const { lib, bookId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [conflict('stale_revision')] })
      expect(await syncV2Library(lib, host())).toBe('failed')
      expect(writes(calls)).toHaveLength(2)
      expect((await lib.outbox()).map((o) => `${o.kind}:${o.failures}`)).toEqual(['state:1'])
    })

    it('tryAgain_NoSession_ListRefreshedRightAfterTheUnpark', async () => {
      const { lib, bookId } = await seeded()
      await lib.park({ kind: 'book', target: bookId, gen: 1, failures: 0 }, 'invalid_payload')
      const order: string[] = []
      const refresh = vi.fn(async () => { order.push('refresh'); return lib.books() })
      await tryAgainV2Book(lib, bookId, refresh, () => order.push('sync'))
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
      expect(await syncV2Library(lib, host())).toBe('done')
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
      expect(await syncV2Library(lib, host())).toBe('failed')
      fakeApi({})
      const online = globalThis.fetch
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === 'PUT') throw new TypeError('Network request failed')
        return online(url, init)
      }))
      expect(await syncV2Library(lib, host())).toBe('failed')
      expect(await resetMidCall(() => v2Store.reset(), {
        'GET /status': ok({ maxPartBytes: 1024 }),
        'GET /library/changes': feed()[0], 'GET /reading/changes': feed()[0], 'GET /annotations/changes': feed()[0],
        [`PUT /books/${bookId}/reading-state`]: { status: 500 },
      }, () => syncV2Library(lib, host()), '/reading-state')).toBe('dropped')
      expect((await lib.outbox()).map((o) => `${o.kind}:${o.failures}`)).toEqual(['state:0'])
      // ...and a 500 is counted.
      fakeApi({ [`PUT /books/${bookId}/reading-state`]: E500 })
      await syncV2Library(lib, host())
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
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        const path = url.replace(V2, '').split('?')[0]
        if (path === '/status') return { ok: true, status: 200, text: async () => JSON.stringify({ maxPartBytes: 1024 }) }
        if (path.endsWith('/changes')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [], cursor: null, hasMore: false }) }
        await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.6, at: NOW - 80 }), newId)
        return { ok: false, status: 500, text: async () => '' }
      }))
      warn.mockClear()
      await syncV2Library(lib, host())
      const [item] = await lib.outbox()
      expect(item.failures).toBe(0)
      expect(warn).not.toHaveBeenCalled() // the old gen's failure: neither counted nor logged
      const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 2))] })
      await syncV2Library(lib, host())
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
      expect(await syncV2Library(lib, host())).toBe('done')
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
      const bookId = await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      await lib.writeEntry(SHA, entry(), newId)
      const fileId = (await lib.book(bookId))!.file_id!
      db.raw.exec(`UPDATE reading_state SET position = '{secret book text'`)
      fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
      })
      await syncV2Library(lib, host())
      const logged = JSON.stringify(warn.mock.calls)
      expect(logged).toContain('SyntaxError')
      expect(logged).not.toMatch(/secret|JSON/)
      // A refusal's server message is clipped like any other reason.
      const other = await lib.addOpened({ sha256: 'cd'.repeat(32), size: 10, title: 'U', author: '', originalName: 'u.epub', format: 'epub' }, newId)
      fakeApi({
        [`GET /books/by-sha256/${'cd'.repeat(32)}`]: [{ status: 404 }],
        [`PUT /books/${other}`]: [{ status: 400, body: { code: 'invalid_payload', field: 'title', message: 'y'.repeat(300) } }],
      })
      await syncV2Library(lib, host())
      expect((await lib.book(other))?.blocked).toBe(`400 invalid_payload: ${'y'.repeat(120)} (title)`)
    })
  })

  // QA #1186: mutation survivors killed, plus the repros, fixed or pinned as decisions in the fix round.
  describe('QA #1186 (outbox backoff)', () => {
    const E500 = [{ status: 500 }]
    const bookImport500 = (bookId: string) => ({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: E500 })
    const passes = async (lib: LocalLibrary, count: number, h = host()) => { for (let i = 0; i < count; i++) await syncV2Library(lib, h) }
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
      const bookId = await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      await lib.failed({ kind: 'book', target: bookId, gen: 1, failures: 0 })
      await lib.queueBook(bookId)
      expect(await lib.outbox()).toEqual([{ kind: 'book', target: bookId, gen: 1, failures: 1 }])
    })

    it('qa_droppedPass_500ArrivesAfterTheSessionChanged_NotCountedNotLogged', async () => {
      const { lib, bookId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      warn.mockClear()
      expect(await resetMidCall(() => v2Store.reset(), {
        'GET /status': ok({ maxPartBytes: 1024 }),
        'GET /library/changes': feed()[0], 'GET /reading/changes': feed()[0], 'GET /annotations/changes': feed()[0],
        [`PUT /books/${bookId}/reading-state`]: { status: 500 },
      }, () => syncV2Library(lib, host()), '/reading-state')).toBe('dropped')
      expect(await counts(lib)).toEqual(['state:0'])
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('not pushed'))).toEqual([])
    })

    it('qa_stateStaleRetryInsideThePassFails500_CountedOncePerPass', async () => {
      const { lib, bookId } = await synced()
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
      const calls = fakeApi({ [`PUT /books/${bookId}/reading-state`]: [conflict('stale_revision'), { status: 500 }] })
      await syncV2Library(lib, host())
      expect(writes(calls)).toHaveLength(2)
      expect(await counts(lib)).toEqual(['state:1'])
    })

    it('qa_corruptLocalPosition_ThrowsLocally_CountedThenSkipped_AnnotationStillPushed', async () => {
      const db = memoryDb()
      const lib = createLocalLibrary(db)
      const bookId = await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
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
      expect(await syncV2Library(lib, host())).toBe('done')
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
      expect(await syncV2Library(lib, host())).toBe('done')
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
      await syncV2Library(lib, host())
      expect(await counts(lib)).toEqual(['book:1', 'state:0', 'annotation:0'])
      expect(await lib.state(bookId)).toMatchObject({ position: expect.any(String) })
      const ok2 = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
        [`PUT /books/${bookId}/reading-state`]: [ok(serverState(bookId, fileId, 1))],
        [`PUT /annotations/${HL}`]: [ok(serverAnnotation(bookId, fileId, 1), 201)],
      })
      expect(await syncV2Library(lib, host())).toBe('done')
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
      await syncV2Library(lib, host())
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
      await syncV2Library(lib, host())
      expect((await lib.outbox('book'))[0]).toMatchObject({ target: nid, failures: 1 })
    })

    // Terminal refusals: "Try again" costs one request and parks again; no loop.
    it('qa_unparkAfterInvalidPayload_OneRequestPerTryAgain_ParkedAgainNoLoop', async () => {
      const { lib, bookId } = await seeded()
      const calls = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [conflict('invalid_payload', { field: 'title' }, 400)] })
      await syncV2Library(lib, host())
      await lib.unpark(bookId)
      await passes(lib, 3)
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}`])
      expect((await lib.book(bookId))?.blocked).toMatch(/invalid_payload/)
    })

    // Another account's passes are refused (#1070 rule D): a parked book is not sent to it.
    it('qa_bookParkedByARefusal_AnotherAccount_RefusedNothingSent', async () => {
      const lib = createLocalLibrary(memoryDb())
      const bookId = await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
      fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [conflict('invalid_payload', { field: 'title' }, 400)] })
      await passes(lib, 1)
      expect((await lib.book(bookId))?.blocked).toMatch(/invalid_payload/)
      v2Store.reset()
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
      const other = await lib.addOpened({ sha256: SHA2, size: 10, title: 'U', author: '', originalName: 'u.epub', format: 'epub' }, newId)
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`GET /books/by-sha256/${SHA2}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [{ status: 503, body: { code: 'internal', message: 'upstream' } }],
        [`PUT /books/${other}`]: [ok(serverBook(other, (await lib.book(other))!.file_id!, {}, { sha256: SHA2 }), 201)],
      })
      for (let i = 0; i < 3; i++) expect(await syncV2Library(lib, host())).toBe('failed')
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`, `PUT /books/${bookId}`, `PUT /books/${bookId}`])
      expect(await counts(lib)).toEqual(['book:0', 'book:0', 'state:0', 'annotation:0'])
    })

    // File sync has its own catch: failures are not counted; the upload is retried every pass.
    it('qa_fileSyncUploadFailing_NotCounted_RetriedEveryPass_OutboxUntouched', async () => {
      const { lib } = await synced()
      await lib.setFileSync(true)
      fakeApi({})
      const upload = vi.fn(async () => { throw new Error('upload 500') })
      await passes(lib, MAX_FAILURES + 2, host({ upload }))
      expect(upload).toHaveBeenCalledTimes(MAX_FAILURES + 2)
      expect(await lib.outbox()).toEqual([])
    })
  })
})
