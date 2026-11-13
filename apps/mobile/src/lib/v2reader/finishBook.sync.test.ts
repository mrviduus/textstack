/**
 * "Finish book" on the device (#1266): the local `completed_at`, its way through the outbox to the server and
 * back from a pull, against the fake V2 API on a real SQLite. PDD "Reading state": set once, cleared only by a reset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initApi } from '@textstack/shared'
import { resetV2ForTests } from '../v2'
import { createLocalLibrary, type LocalLibrary, type PositionAction } from './localLibrary'
import { memoryDb } from './sqliteShim'
import { createV2Storage, type V2Files } from './hostStorage'
import { syncV2Library, type SyncHost } from './sync'
import { fakeApi as fakeV2, conflict, feed, type Answer, type Call } from '../../../../../packages/shared/src/api/__tests__/fakeV2Api'

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))
vi.mock('../offlineDb', () => ({ dropReplacedUserBookFiles: async () => [] }))
vi.mock('../originalFileCache', () => ({ deleteOriginal: async () => {} }))

const V2 = 'http://api/me/v2'
const SHA = 'ab'.repeat(32)
const CFI = 'epubcfi(/6/14!/4/2/1:0)'
const NOW = Date.now()
const AT = '2026-11-13T10:00:00.000Z'
const pos = { cfi: CFI, quote: 'It was a bright cold day', index: 6, fraction: 0.97, at: NOW - 60_000 }

let n = 0
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const entry = (position: unknown = pos) => JSON.stringify({ v: 1, book: { sha256: SHA, size: 10, name: 'b.epub' }, position, highlights: [] })
const serverBook = (id: string, fileId: string) => ({
  id, title: 'T', author: null, tags: [], hasCover: false, revision: 1, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', removedAt: null,
  currentFile: { id: fileId, sha256: SHA, byteSize: 10, originalName: 'b.epub', format: 'epub', hasContent: false, contentRemovedAt: null, isCurrent: true },
})
const serverState = (bookId: string, fileId: string, revision: number, extra: object = {}) => ({
  bookId, fileId, currentLocator: { version: 1, scheme: 'epub-cfi', value: CFI, quote: pos.quote }, bookFraction: 0.97,
  frontierLocator: null, frontierFraction: null, completedAt: null, clientRecordedAt: new Date(pos.at).toISOString(),
  updatedAt: '2026-11-10T00:00:01Z', revision, resetRevision: null, ...extra,
})
const ok = (body: unknown, status = 200): Answer => ({ status, body })
const fakeApi = (routes: Record<string, Answer[]>) => fakeV2({
  'GET /status': [ok({ maxPartBytes: 1024 })], 'GET /library/changes': feed(), 'GET /reading/changes': feed(), 'GET /annotations/changes': feed(), ...routes,
}, V2)
const stateWrites = (calls: Call[]) => calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/reading-state')).map((c) => c.body)

function host(extra: Partial<SyncHost> = {}): SyncHost & { owed: PositionAction[] } {
  const owed: PositionAction[] = []
  return { userId: 'u1', newId, reader: () => null, onPosition: (a) => owed.push(a), guest: false, owed, ...extra }
}

/** A book with a position, pushed: the server holds its state at revision 1, nothing queued. */
async function synced(db = memoryDb()): Promise<{ lib: LocalLibrary; bookId: string; fileId: string; state: string }> {
  const lib = createLocalLibrary(db)
  const bookId = await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
  await lib.writeEntry(SHA, entry(), newId)
  const fileId = (await lib.book(bookId))!.file_id!
  const state = `PUT /books/${bookId}/reading-state`
  fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)], [state]: [ok(serverState(bookId, fileId, 1))] })
  expect(await syncV2Library(lib, host())).toBe('done')
  expect(await lib.outbox()).toEqual([])
  return { lib, bookId, fileId, state }
}
const finished = async (lib: LocalLibrary) => (await lib.books()).map((b) => b.finished)

describe('finish book on the device (#1266)', () => {
  beforeEach(() => {
    resetV2ForTests()
    n = 0
    initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('finish_ThenSync_PushCarriesCompletedAtWithThePlaceAndTheListShowsFinished', async () => {
    const { lib, bookId, fileId, state } = await synced()
    expect(await finished(lib)).toEqual([false])
    expect(await lib.finish(bookId, AT)).toBe(true)
    expect(await finished(lib)).toEqual([true])
    const calls = fakeApi({ [state]: [ok(serverState(bookId, fileId, 2, { completedAt: AT }))] })
    await syncV2Library(lib, host())
    // The real fraction (owner 2026-11-13: not forced to 1), on the revision last seen.
    expect(stateWrites(calls)).toEqual([expect.objectContaining({ expectedRevision: 1, completedAt: AT, bookFraction: 0.97, currentLocator: expect.objectContaining({ value: CFI }) })])
    expect(await lib.outbox()).toEqual([])
    expect(await lib.state(bookId)).toMatchObject({ revision: 2, completed_at: AT })
  })

  it('finish_Twice_SetOnceAndQueuedOnce', async () => {
    const { lib, bookId } = await synced()
    expect(await lib.finish(bookId, AT)).toBe(true)
    const queued = await lib.outbox()
    expect(await lib.finish(bookId, '2026-11-14T00:00:00.000Z')).toBe(false)
    expect((await lib.state(bookId))!.completed_at).toBe(AT)
    expect(await lib.outbox()).toEqual(queued)
    expect(queued).toEqual([expect.objectContaining({ kind: 'state', target: bookId, gen: 1 })])
  })

  it('finish_TwoTapsAtOnce_OneWinsOneQueueEntry', async () => {
    const { lib, bookId } = await synced()
    expect((await Promise.all([lib.finish(bookId, AT), lib.finish(bookId, AT)])).sort()).toEqual([false, true])
    expect(await lib.outbox()).toEqual([expect.objectContaining({ gen: 1 })])
  })

  it('finish_NoSuchBook_FalseAndNothingWritten', async () => {
    const { lib } = await synced()
    expect(await lib.finish('nope', AT)).toBe(false)
    expect(await lib.state('nope')).toBeNull()
    expect(await lib.outbox()).toEqual([])
  })

  it('finish_Offline_KeptAndQueuedThenSentByALaterPass', async () => {
    const { lib, bookId, fileId, state } = await synced()
    await lib.finish(bookId, AT)
    fakeApi({ [state]: [{ status: 500 }] })
    await syncV2Library(lib, host())
    expect(await finished(lib)).toEqual([true])
    expect(await lib.outbox()).toEqual([expect.objectContaining({ kind: 'state', target: bookId })])
    const calls = fakeApi({ [state]: [ok(serverState(bookId, fileId, 2, { completedAt: AT }))] })
    await syncV2Library(lib, host())
    expect(stateWrites(calls)).toEqual([expect.objectContaining({ completedAt: AT })])
    expect(await lib.outbox()).toEqual([])
  })

  it('finish_ThenThePlaceMoves_LaterWritesKeepSendingTheSameCompletedAt', async () => {
    const { lib, bookId, fileId, state } = await synced()
    await lib.finish(bookId, AT)
    fakeApi({ [state]: [ok(serverState(bookId, fileId, 2, { completedAt: AT }))] })
    await syncV2Library(lib, host())
    await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
    expect((await lib.state(bookId))!.completed_at).toBe(AT)
    const calls = fakeApi({ [state]: [ok(serverState(bookId, fileId, 3, { completedAt: AT }))] })
    await syncV2Library(lib, host())
    expect(stateWrites(calls)).toEqual([expect.objectContaining({ expectedRevision: 2, bookFraction: 0.5, completedAt: AT })])
  })

  it('sync_NotFinished_WriteCarriesNoCompletedAt', async () => {
    const { lib, bookId, fileId, state } = await synced()
    await lib.writeEntry(SHA, entry({ ...pos, fraction: 0.5, at: NOW - 100 }), newId)
    const calls = fakeApi({ [state]: [ok(serverState(bookId, fileId, 2))] })
    await syncV2Library(lib, host())
    expect(stateWrites(calls)).toHaveLength(1)
    expect(stateWrites(calls)[0]).not.toHaveProperty('completedAt')
  })

  it('pull_FinishedOnAnotherDevice_ShownFinishedNothingQueued', async () => {
    const { lib, bookId, fileId } = await synced()
    const calls = fakeApi({ 'GET /reading/changes': feed(serverState(bookId, fileId, 2, { completedAt: AT })) })
    await syncV2Library(lib, host())
    expect(await lib.state(bookId)).toMatchObject({ revision: 2, completed_at: AT })
    expect(await finished(lib)).toEqual([true])
    expect(stateWrites(calls)).toEqual([])
    expect(await lib.outbox()).toEqual([])
  })

  it('pull_FinishedOnAnotherDeviceABookNotImportedHere_ShownFinished', async () => {
    const lib = createLocalLibrary(memoryDb())
    const book = { ...serverBook('b9', 'f9'), currentFile: { ...serverBook('b9', 'f9').currentFile, hasContent: true } }
    fakeApi({ 'GET /library/changes': feed(book), 'GET /reading/changes': feed(serverState('b9', 'f9', 3, { completedAt: AT })) })
    await syncV2Library(lib, host())
    expect((await lib.books()).map((b) => [b.local, b.finished])).toEqual([[false, true]])
  })

  it('pull_ResetOnAnotherDeviceAfterFinish_CompletionCleared', async () => {
    const { lib, bookId, fileId, state } = await synced()
    await lib.finish(bookId, AT)
    fakeApi({ [state]: [ok(serverState(bookId, fileId, 2, { completedAt: AT }))] })
    await syncV2Library(lib, host())
    fakeApi({ 'GET /reading/changes': feed(serverState(bookId, fileId, 3, { resetRevision: 3 })) })
    await syncV2Library(lib, host())
    expect(await lib.state(bookId)).toMatchObject({ revision: 3, completed_at: null })
    expect(await finished(lib)).toEqual([false])
  })

  it('pull_ResetThisDeviceAlreadySawThenFinishedHere_CompletionKept', async () => {
    const { lib, bookId, fileId } = await synced()
    fakeApi({ 'GET /reading/changes': feed(serverState(bookId, fileId, 3, { resetRevision: 3 })) })
    await syncV2Library(lib, host())
    await lib.finish(bookId, AT)
    // Another device moved on revision 4: the old reset (3, seen) is not a new one.
    await lib.applyStates([serverState(bookId, fileId, 4, { resetRevision: 3 }) as never], () => null)
    expect(await lib.state(bookId)).toMatchObject({ revision: 4, completed_at: AT })
    expect(await lib.outbox()).toEqual([expect.objectContaining({ kind: 'state' })])
  })

  it('pull_ServerNotFinishedNoReset_LocalFinishStaysOwed', async () => {
    const { lib, bookId, fileId, state } = await synced()
    await lib.finish(bookId, AT)
    // Their state is older than ours: kept, and ours (with the completion) is written on their revision.
    const calls = fakeApi({
      'GET /reading/changes': feed(serverState(bookId, fileId, 5, { clientRecordedAt: new Date(pos.at - 60_000).toISOString() })),
      [state]: [ok(serverState(bookId, fileId, 6, { completedAt: AT }))],
    })
    await syncV2Library(lib, host())
    await syncV2Library(lib, host())
    expect(stateWrites(calls).at(-1)).toMatchObject({ completedAt: AT })
    expect((await lib.state(bookId))!.completed_at).toBe(AT)
    expect(await lib.outbox()).toEqual([])
  })

  it('push_LostToAReset_CompletionDroppedAndThePlaceWrittenAgainWithoutIt', async () => {
    const { lib, bookId, fileId, state } = await synced()
    await lib.finish(bookId, AT)
    const calls = fakeApi({ [state]: [conflict('reset', { revision: 9, current: serverState(bookId, fileId, 9, { resetRevision: 9 }) }), ok(serverState(bookId, fileId, 10))] })
    await syncV2Library(lib, host())
    const sent = stateWrites(calls)
    expect(sent.map((w) => w.expectedRevision)).toEqual([1, 9])
    expect(sent[0]).toMatchObject({ completedAt: AT })
    expect(sent[1]).not.toHaveProperty('completedAt')
    expect(await lib.state(bookId)).toMatchObject({ revision: 10, completed_at: null })
    expect(await finished(lib)).toEqual([false])
    expect(await lib.outbox()).toEqual([])
  })

  it('push_StaleOnTheSamePlaceWithoutOurCompletion_NotTakenAsOursWrittenAgain', async () => {
    const { lib, bookId, fileId, state } = await synced()
    await lib.finish(bookId, AT)
    // The same locator and instant (our earlier position write, re-stamped by another writer's revision), not finished.
    const calls = fakeApi({ [state]: [conflict('stale_revision', { revision: 2, current: serverState(bookId, fileId, 2) }), ok(serverState(bookId, fileId, 3, { completedAt: AT }))] })
    await syncV2Library(lib, host())
    expect(stateWrites(calls).map((w) => [w.expectedRevision, w.completedAt])).toEqual([[1, AT], [2, AT]])
    expect(await lib.state(bookId)).toMatchObject({ revision: 3, completed_at: AT })
    expect(await lib.outbox()).toEqual([])
  })

  it('push_StaleOnOurOwnCompletedWrite_TakenAsLanded', async () => {
    const { lib, bookId, fileId, state } = await synced()
    await lib.finish(bookId, AT)
    const calls = fakeApi({ [state]: [conflict('stale_revision', { revision: 2, current: serverState(bookId, fileId, 2, { completedAt: AT }) })] })
    await syncV2Library(lib, host())
    expect(stateWrites(calls)).toHaveLength(1)
    expect(await lib.state(bookId)).toMatchObject({ revision: 2, completed_at: AT })
    expect(await lib.outbox()).toEqual([])
  })

  it('push_StaleTheirsNewerAdopted_FinishStaysQueuedAndIsSentOnTheirPlace', async () => {
    const { lib, bookId, fileId, state } = await synced()
    await lib.finish(bookId, AT)
    const theirs = (revision: number, extra: object = {}) => serverState(bookId, fileId, revision, {
      currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/14!/4/2/9:0)', quote: 'theirs' }, bookFraction: 0.55, clientRecordedAt: new Date(NOW - 1000).toISOString(), ...extra,
    })
    const calls = fakeApi({ [state]: [conflict('stale_revision', { revision: 4, current: theirs(4) }), ok(theirs(5, { completedAt: AT }))] })
    const h = host()
    await syncV2Library(lib, h)
    expect(h.owed).toEqual([expect.objectContaining({ action: 'adopt' })])
    expect(await lib.state(bookId)).toMatchObject({ revision: 4, completed_at: AT })
    expect(await lib.outbox()).toEqual([expect.objectContaining({ kind: 'state', target: bookId })])
    await syncV2Library(lib, h)
    expect(stateWrites(calls).at(-1)).toMatchObject({ expectedRevision: 4, completedAt: AT, bookFraction: 0.55 })
    expect(await lib.outbox()).toEqual([])
  })

  it('pull_TheirsNewerAdoptedAndFinishedThere_NothingQueued', async () => {
    const { lib, bookId, fileId } = await synced()
    fakeApi({ 'GET /reading/changes': feed(serverState(bookId, fileId, 4, { clientRecordedAt: new Date(NOW - 1000).toISOString(), completedAt: AT })) })
    await syncV2Library(lib, host())
    expect(await lib.state(bookId)).toMatchObject({ revision: 4, completed_at: AT })
    expect(await lib.outbox()).toEqual([])
  })

  it('migration_ReadingStateWithoutTheColumn_UpgradedOnOpenRowsKept_TwoColdStarts', async () => {
    const db = memoryDb()
    // The table as a build before #1266 made it, with a row.
    db.raw.exec(`CREATE TABLE reading_state (book_id TEXT PRIMARY KEY, position TEXT, file_id TEXT, revision INTEGER, revision_file_id TEXT);
      INSERT INTO reading_state (book_id, position, file_id, revision, revision_file_id) VALUES ('b1', '{"cfi":"x"}', 'f1', 7, 'f1')`)
    const first = createLocalLibrary(db)
    expect(await first.state('b1')).toEqual({ book_id: 'b1', position: '{"cfi":"x"}', file_id: 'f1', revision: 7, revision_file_id: 'f1', completed_at: null })
    const bookId = await first.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
    expect(await first.finish(bookId, AT)).toBe(true)
    // A second cold start: the duplicate column is the check, nothing is lost.
    const again = createLocalLibrary(db)
    expect((await again.state(bookId))!.completed_at).toBe(AT)
    expect(await again.state('b1')).toMatchObject({ revision: 7, completed_at: null })
    expect(await finished(again)).toEqual([true])
  })

  it('finishBook_ThroughTheHostStorage_ResolvesToTheBooksWithItFinished', async () => {
    const { lib, bookId } = await synced()
    const files: V2Files = { read: async () => null, move: async () => {}, exists: () => false, remove: () => {}, copyIn: async () => {} }
    const storage = createV2Storage(files, newId, lib)
    expect((await storage.finishBook(bookId)).map((b) => b.finished)).toEqual([true])
    expect((await storage.finishBook(bookId)).map((b) => b.finished)).toEqual([true])
    expect(await lib.outbox()).toEqual([expect.objectContaining({ kind: 'state', gen: 1 })])
  })
})
