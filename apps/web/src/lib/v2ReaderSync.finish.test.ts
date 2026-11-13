import { ApiError, type V2ReadingState, type V2ReadingStateWrite } from '@textstack/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createV2ReaderSync, type V2ReaderSyncApi, type V2SyncTarget } from './v2ReaderSync'

// #1266: Finish book through the open book's session — the state as the server holds it, plus `completedAt`, on
// its revision; the session keeps writing on the revision that write made.

const T: V2SyncTarget = { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: 'ab'.repeat(32), size: 100, name: 'a.epub' }
const cfi = (n: number) => `epubcfi(/6/${2 * n + 2}!/4/2/1:0)`
const pos = (n: number, at = 1_000) => ({ cfi: cfi(n), quote: `quote ${n}`, index: n, fraction: n / 10, at })
const entry = (position: object) => JSON.stringify({ v: 1, book: { sha256: T.sha256, size: T.size, name: T.name }, position, highlights: [] })
const AT = '2026-11-01T00:00:00.000Z'
const DONE = '2026-11-13T10:00:00.000Z'
const state = (revision: number, n = 1, extra: Partial<V2ReadingState> = {}): V2ReadingState => ({
  bookId: T.bookId, fileId: T.fileId, currentLocator: { version: 1, scheme: 'epub-cfi', value: cfi(n), quote: `quote ${n}` },
  bookFraction: n / 10, frontierLocator: null, frontierFraction: null, completedAt: null, clientRecordedAt: AT, updatedAt: AT, revision, resetRevision: null, ...extra,
})

/** A server of one reading state: every accepted write is revision + 1; `completed_at` is `COALESCE(old, new)`. */
let server: V2ReadingState | null
let api: { [K in keyof V2ReaderSyncApi]: ReturnType<typeof vi.fn> }
let completed: (string | null)[]
let newer: unknown[]

beforeEach(() => {
  completed = []
  newer = []
  server = state(4, 9)
  api = {
    getReadingState: vi.fn(async () => server),
    annotations: vi.fn().mockResolvedValue([]),
    putReadingState: vi.fn(async (_b: string, w: V2ReadingStateWrite) => {
      if ((w.expectedRevision ?? 0) !== (server?.revision ?? 0)) throw Object.assign(new ApiError(409, 'stale_revision'), { body: { code: 'stale_revision', message: '', current: server } })
      return (server = {
        ...state((server?.revision ?? 0) + 1), currentLocator: w.currentLocator, bookFraction: w.bookFraction, clientRecordedAt: w.clientRecordedAt,
        completedAt: server?.completedAt ?? w.completedAt ?? null,
      })
    }),
    putAnnotation: vi.fn(),
    keepalivePutState: vi.fn(),
    keepalivePutAnnotation: vi.fn(),
  }
})

const open = (t: V2SyncTarget = T) => createV2ReaderSync(t, {
  api: api as unknown as V2ReaderSyncApi, onStatus: () => {}, onHighlights: () => {}, onNewerPlace: (p) => newer.push(p),
  onCompleted: (at) => completed.push(at), highlights: false,
})
async function opened() {
  const s = open()
  await s.restore()
  return s
}
const writes = () => api.putReadingState.mock.calls.map((c) => c[1] as V2ReadingStateWrite)

describe('createV2ReaderSync complete (#1266)', () => {
  it('restore_NotFinished_TellsTheHostNull_Finished_ItsTime', async () => {
    await opened()
    server = state(5, 9, { completedAt: DONE })
    await opened()
    expect(completed).toEqual([null, DONE])
  })

  it('restore_FinishedOnAnotherFileVersion_NotFinishedOnThisOne', async () => {
    server = state(5, 9, { completedAt: DONE, fileId: 'old' })
    await opened()
    expect(completed).toEqual([null])
  })

  it('complete_StateOnTheServer_WrittenAsItStandsWithCompletedAtOnItsRevision', async () => {
    const s = await opened()
    const at = await s.complete()
    expect(writes()).toEqual([{
      expectedRevision: 4, fileId: 'f1', currentLocator: state(4, 9).currentLocator, bookFraction: 0.9, completedAt: at, clientRecordedAt: AT,
    }])
    expect(Number.isNaN(Date.parse(at))).toBe(false)
    expect(server).toMatchObject({ revision: 5, completedAt: at, bookFraction: 0.9 })
  })

  it('complete_ThenTheReaderMoves_NextWriteOnTheCompletionsRevisionAndNoPlaceOffered', async () => {
    const s = await opened()
    await s.complete()
    s.store(entry(pos(8, Date.now())))
    await s.flush()
    expect(writes().map((w) => w.expectedRevision)).toEqual([4, 5])
    expect(newer).toEqual([])
    expect(server).toMatchObject({ revision: 6, bookFraction: 0.8, completedAt: expect.any(String) })
  })

  it('complete_AnUnsavedMovePending_ThePlaceIsWrittenFirstThenCompleted', async () => {
    const s = await opened()
    s.store(entry(pos(10, Date.now())))
    await s.complete()
    expect(writes().map((w) => [w.expectedRevision, w.bookFraction, !!w.completedAt])).toEqual([[4, 1, false], [5, 1, true]])
  })

  it('complete_AlreadyFinished_NothingWrittenItsTimeReturned', async () => {
    const s = await opened()
    server = state(7, 9, { completedAt: DONE })
    expect(await s.complete()).toBe(DONE)
    expect(writes()).toEqual([])
    // The session writes on the revision it just read.
    s.store(entry(pos(8, Date.now())))
    await s.flush()
    expect(writes().map((w) => w.expectedRevision)).toEqual([7])
  })

  it('complete_Offline_RejectsAndARetryLands', async () => {
    const s = await opened()
    api.putReadingState.mockRejectedValueOnce(new ApiError(0, 'offline'))
    await expect(s.complete()).rejects.toThrow('offline')
    expect(server!.completedAt).toBeNull()
    expect(await s.complete()).toBe(server!.completedAt)
    expect(server!.completedAt).not.toBeNull()
  })

  it('complete_TheReadFails_RejectsNothingWritten', async () => {
    const s = await opened()
    api.getReadingState.mockRejectedValueOnce(new ApiError(503, 'down'))
    await expect(s.complete()).rejects.toThrow('down')
    expect(writes()).toEqual([])
  })

  it('complete_LostToAnotherWriter_RejectsAndARetryWritesOnTheNewRevision', async () => {
    const s = await opened()
    api.getReadingState.mockImplementationOnce(async () => {
      const read = server
      server = state(5, 9)
      return read
    })
    await expect(s.complete()).rejects.toMatchObject({ status: 409 })
    await s.complete()
    expect(writes().map((w) => w.expectedRevision)).toEqual([4, 5])
    expect(server!.completedAt).not.toBeNull()
  })

  it('complete_NoStateOnThisFile_RejectsNothingWritten', async () => {
    server = null
    const s = await opened()
    await expect(s.complete()).rejects.toThrow('no reading state')
    server = state(3, 9, { fileId: 'old' })
    await expect(s.complete()).rejects.toThrow('no reading state')
    expect(writes()).toEqual([])
  })

  it('complete_BeforeTheRestoreOrAfterClose_RejectsNothingRead', async () => {
    const early = open()
    await expect(early.complete()).rejects.toThrow('not open')
    const s = await opened()
    await s.close()
    api.getReadingState.mockClear()
    await expect(s.complete()).rejects.toThrow('not open')
    expect(api.getReadingState).not.toHaveBeenCalled()
  })

  it('complete_TheServerAnswersWithoutACompletion_Rejects', async () => {
    const s = await opened()
    api.putReadingState.mockResolvedValueOnce(state(5, 9))
    await expect(s.complete()).rejects.toThrow('did not keep')
  })
})
