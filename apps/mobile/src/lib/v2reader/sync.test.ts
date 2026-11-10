/**
 * R6's DoD (#1038): the local library's sync client against the fake V2 API, on a real SQLite
 * (node:sqlite). Conflict tests: simultaneous edit, stale revision, reset, file_replaced, offline
 * queue replay (idempotent by client id / revision / own write), sign-out mid-sync (the shared
 * `whileCurrent` epoch guard), plus the pull merges, id re-keying, opt-in file sync and download.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initApi, V2UploadNotOnServer, type OpenReader } from '@textstack/shared'
import { resetV2ForTests, v2Store, V2UploadError } from '../v2'
import { createLocalLibrary, type LocalLibrary, type PositionAction } from './localLibrary'
import { memoryDb } from './sqliteShim'
import { adoptV2LocalAccount, downloadV2Book, syncV2Library, type SyncHost } from './sync'
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

function host(extra: Partial<SyncHost> = {}): SyncHost & { owed: PositionAction[] } {
  const owed: PositionAction[] = []
  return { userId: 'u1', newId, reader: () => null, onPosition: (a) => owed.push(a), owed, ...extra }
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

      it('pull_NewerStateWhileUnmovedOnAFractionLanding_MovedSilentlyNoWrite', async () => {
        // Landed by fraction at rev 3, not moved since: rev 4 from another device moves the reader, no prompt.
        const { lib, bookId, fileId } = await synced()
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, NOW - 2000)) })
        await syncV2Library(lib, host())
        await lib.writeEntry(SHA, entry((await restoredEntry(lib)).position), newId)
        const calls = fakeApi({ 'GET /reading/changes': feed({ ...transitional(bookId, fileId, 4, NOW - 1000), bookFraction: 0.8 }) })
        const h = host({ reader: () => ({ restoreApplied: true, moved: false, index: 1 }) })
        await syncV2Library(lib, h)
        expect(h.owed).toEqual([expect.objectContaining({ action: 'move', position: { fraction: 0.8, at: NOW - 1000 } })])
        expect((await restoredEntry(lib)).position).toEqual({ fraction: 0.8, at: NOW - 1000 })
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

      it('fractionPosition_OfferTakenAndSaved_NeverSentQueueDrained', async () => {
        // A prompt taken: the page lands the fraction and saves it over the reader's older CFI place.
        const { lib, bookId, fileId } = await synced()
        fakeApi({ 'GET /reading/changes': feed(transitional(bookId, fileId, 3, NOW - 1000)) })
        const h = host({ reader: () => ({ restoreApplied: true, moved: true, index: 6 }) })
        await syncV2Library(lib, h)
        await lib.writeEntry(SHA, entry(h.owed[0].position), newId)
        expect((await lib.outbox()).map((o) => o.kind)).toEqual(['state'])
        const calls = fakeApi({})
        await syncV2Library(lib, host())
        expect(writes(calls)).toEqual([])
        expect(await lib.outbox()).toEqual([])
      })

      // #1187 QA
      it('fractionPosition_RealMoveSavedWhileItsDropIsInFlight_MoveStillPushed', async () => {
        const { lib, bookId, fileId } = await synced()
        await lib.writeEntry(SHA, entry({ fraction: 0.7, at: NOW - 2000 }), newId)
        expect((await lib.outbox()).map((o) => o.kind)).toEqual(['state'])
        // The reader moves after the push read the fraction-only row and before it drops the entry.
        const moved = { ...pos, fraction: 0.72, at: NOW - 1000 }
        const racing: LocalLibrary = { ...lib, state: async (id: string) => { const st = await lib.state(id); await lib.writeEntry(SHA, entry(moved), newId); return st } }
        const first = fakeApi({})
        await syncV2Library(racing, host())
        expect(writes(first)).toEqual([])
        expect((await lib.outbox()).map((o) => o.kind)).toEqual(['state'])
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

      it('fractionPosition_MergeMapReKeyThenAnotherIdentity_KeptHereNeverPushed', async () => {
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
        await syncV2Library(lib, host({ userId: 'someone-else' }))
        expect((await restoredEntry(lib)).position).toEqual({ fraction: 0.7, at })
        expect(writes(calls).filter((w) => w.endsWith('/reading-state'))).toEqual([])
      })
    })

    it('cbzPosition_NoQuote_NeverSent', async () => {
      const lib = createLocalLibrary(memoryDb())
      const bookId = await lib.addOpened({ sha256: SHA, size: 10, title: 'C', author: '', originalName: 'c.cbz', format: 'cbz' }, newId)
      const fileId = (await lib.book(bookId))!.file_id!
      await lib.writeEntry(SHA, entry({ cfi: 'epubcfi(/6/2!/4)', page: 'p1.jpg', index: 0, fraction: 0, at: NOW }, []), newId)
      const calls = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId, {}, { format: 'cbz' }), 201)] })
      await syncV2Library(lib, host())
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`])
      expect(await lib.outbox()).toEqual([])
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
      await lib.done({ kind: 'book', target: other, gen: 1 })
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

  describe('accounts', () => {
    it('anotherIdentity_ServerKnowledgeForgotten_OwnRowsAndQueueKept', async () => {
      const { lib, bookId } = await synced()
      fakeApi({ 'GET /library/changes': feed(serverBook('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', {}, { sha256: 'ef'.repeat(32), hasContent: true })) })
      await syncV2Library(lib, host())
      expect(await lib.books()).toHaveLength(2)
      await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.8, at: NOW }), newId)
      v2Store.reset() // signed out
      // Another identity: the first pass forgets what the server told u1; the book goes to u2 before its state.
      fakeApi({})
      await syncV2Library(lib, host({ userId: 'u2' }))
      expect((await lib.outbox()).map((o) => o.kind)).toEqual(['book', 'state'])
      const calls = fakeApi({
        [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
        [`PUT /books/${bookId}`]: [{ status: 502 }],
      })
      await syncV2Library(lib, host({ userId: 'u2' }))
      expect(await lib.account()).toBe('u2')
      expect((await lib.books()).map((b) => b.id)).toEqual([bookId])
      expect(await lib.state(bookId)).toMatchObject({ revision: null })
      expect((await restoredEntry(lib)).position.fraction).toBe(0.8)
      // This device's own highlight (synced, no longer queued) is not the server's to forget.
      expect((await restoredEntry(lib)).highlights.map((x: { id: string }) => x.id)).toEqual([HL])
      expect(writes(calls)).toEqual([`PUT /books/${bookId}`])
    })

    it('guestSignsIn_MergeMapRekeysTheLibraryCursorsClearedNoForget', async () => {
      const { lib, bookId, fileId } = await synced()
      fakeApi({ 'GET /library/changes': [ok({ items: [], cursor: 'c1', hasMore: false })] })
      await syncV2Library(lib, host())
      expect(await lib.cursor('library')).toBe('c1')
      await adoptV2LocalAccount('u1', 'acct', { books: { [bookId]: 'acct-book' }, files: { [fileId]: 'acct-file' } }, () => lib)
      expect(await lib.account()).toBe('acct')
      expect(await lib.book('acct-book')).toMatchObject({ file_id: 'acct-file', server_file_id: 'acct-file' })
      expect(await lib.state('acct-book')).toMatchObject({ revision: 1, revision_file_id: 'acct-file' })
      expect(await lib.annotation(HL)).toMatchObject({ book_id: 'acct-book', file_id: 'acct-file' })
      expect(await lib.cursor('library')).toBeNull()
      await adoptV2LocalAccount('someone-else', 'x', undefined, () => lib)
      expect(await lib.account()).toBe('acct')
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
      const fresh = syncV2Library(lib, host({ userId: 'u2' }))
      release()
      expect(await fresh).toBe('done')
      expect(await old).toBe('done') // both callers see the last pass's result
      expect(await lib.account()).toBe('u2')
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
      await lib.block(bookId, 'invalid_payload')
      await lib.adoptAccount('u1', { [bookId]: 'acct-book' }, { [fileId]: 'acct-file' }, 'acct')
      expect(await lib.book('acct-book')).toMatchObject({ blocked: 'invalid_payload' })
    })
  })
})
