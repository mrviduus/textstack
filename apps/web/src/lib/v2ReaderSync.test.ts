import { ApiError, type V2Annotation, type V2AnnotationWrite, type V2ReadingState, type V2ReadingStateWrite } from '@textstack/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { v2Store } from '../api/v2'
import { createV2ReaderSync, type V2ReaderSyncApi, type V2SaveStatus, type V2SyncTarget } from './v2ReaderSync'

// #1226: the web V2 host's sync decisions against a fake server — restore, diff, the 409 paths, the stale-open
// and account guards, retry on the next store / flush, and the keepalive write.

const T: V2SyncTarget = { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: 'ab'.repeat(32), size: 100, name: 'a.epub' }
const H1 = '11111111-1111-4111-8111-111111111111'
const cfi = (n: number) => `epubcfi(/6/${2 * n + 2}!/4/2/1:0)`
const pos = (n: number, at = 1_000) => ({ cfi: cfi(n), quote: `quote ${n}`, index: n, fraction: n / 10, at })
const hl = (id = H1, color = 'yellow') => ({ id, cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)', index: 1, quote: 'Hello', selectedText: 'Hello', prefix: '', suffix: '', color, at: 1 })
const entry = (position: object | null, highlights: object[] = []) =>
  JSON.stringify({ v: 1, book: { sha256: T.sha256, size: T.size, name: T.name }, position, highlights })

const state = (revision: number, n = 1, at = '2026-11-01T00:00:00.000Z'): V2ReadingState => ({
  bookId: T.bookId, fileId: T.fileId, currentLocator: { version: 1, scheme: 'epub-cfi', value: cfi(n), quote: `quote ${n}` },
  bookFraction: n / 10, frontierLocator: null, frontierFraction: null, completedAt: null, clientRecordedAt: at, updatedAt: at, revision, resetRevision: null,
})
const annotation = (w: Partial<V2Annotation> & { id: string }): V2Annotation => ({
  bookId: T.bookId, fileId: T.fileId, selectedText: 'Hello', noteText: null, color: 'yellow',
  locator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4/2,/1:0,/1:5)', quote: 'Hello' },
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', deletedAt: null, revision: 1, ...w,
})
const conflict = (code: string, current: unknown) => Object.assign(new ApiError(409, code), { body: { code, message: code, current } })

let api: { [K in keyof V2ReaderSyncApi]: ReturnType<typeof vi.fn> }
let statuses: V2SaveStatus[]

beforeEach(() => {
  statuses = []
  api = {
    getReadingState: vi.fn().mockResolvedValue(null),
    annotations: vi.fn().mockResolvedValue([]),
    putReadingState: vi.fn(async (_b: string, w: V2ReadingStateWrite) => ({ ...state((w.expectedRevision ?? 0) + 1), currentLocator: w.currentLocator, clientRecordedAt: w.clientRecordedAt })),
    putAnnotation: vi.fn(async (id: string, w: V2AnnotationWrite) => annotation({ id, color: w.color, revision: (w.expectedRevision ?? 0) + 1 })),
    keepalivePutState: vi.fn(),
  }
})

const open = () => createV2ReaderSync(T, { api: api as unknown as V2ReaderSyncApi, onStatus: (s) => statuses.push(s), newId: () => 'never' })
const expectedOf = (call: unknown[]) => (call[1] as { expectedRevision: number | null }).expectedRevision

describe('createV2ReaderSync', () => {
  it('restore_ServerStateAndThisFilesLiveHighlights_TheEntry', async () => {
    api.getReadingState.mockResolvedValue(state(4, 2))
    api.annotations.mockResolvedValue([
      annotation({ id: H1 }),
      annotation({ id: '22222222-2222-4222-8222-222222222222', deletedAt: '2026-11-02T00:00:00Z' }),
      annotation({ id: '33333333-3333-4333-8333-333333333333', fileId: 'old' }),
      annotation({ id: '44444444-4444-4444-8444-444444444444', bookId: 'other' }),
    ])
    const e = JSON.parse((await open().restore())!)
    expect(e.position).toMatchObject({ cfi: cfi(2), quote: 'quote 2', index: 2, fraction: 0.2 })
    expect(e.highlights.map((h: { id: string }) => h.id)).toEqual([H1])
    expect(e.book).toEqual({ sha256: T.sha256, size: T.size, name: T.name })
  })

  it('restore_ServerUnreachable_NullAndUnsaved', async () => {
    api.getReadingState.mockRejectedValue(new ApiError(0, 'offline'))
    expect(await open().restore()).toBeNull()
    expect(statuses).toEqual(['unsaved'])
  })

  it('store_PositionMoved_WrittenOnTheRestoredRevision_SameAgainNotWritten', async () => {
    api.getReadingState.mockResolvedValue(state(4, 1))
    const s = open()
    await s.restore()
    s.store(entry(pos(1, 5)))
    await s.flush()
    s.store(entry(pos(3)))
    await s.flush()
    expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([4, 5])
    expect(api.putReadingState).toHaveBeenLastCalledWith('b1', expect.objectContaining({ fileId: 'f1' }))
    const n = api.putReadingState.mock.calls.length
    s.store(entry(pos(3)))
    await s.flush()
    expect(api.putReadingState).toHaveBeenCalledTimes(n)
    expect(statuses[statuses.length - 1]).toBe('saved')
  })

  it('store_NotThisBooksEntry_NothingWritten', async () => {
    const s = open()
    await s.restore()
    s.store(entry(pos(2)).replace(T.sha256, 'cd'.repeat(32)))
    s.store('{not json')
    await s.flush()
    expect(api.putReadingState).not.toHaveBeenCalled()
  })

  it('positionStaleRevision_OwnWriteLost_AcceptedNoRetry', async () => {
    const s = open()
    await s.restore()
    api.putReadingState.mockImplementationOnce(async (_b: string, w: V2ReadingStateWrite) => {
      throw conflict('stale_revision', { ...state(7), currentLocator: w.currentLocator, clientRecordedAt: w.clientRecordedAt })
    })
    s.store(entry(pos(2)))
    await s.flush()
    expect(api.putReadingState).toHaveBeenCalledTimes(1)
    s.store(entry(pos(3)))
    await s.flush()
    expect(expectedOf(api.putReadingState.mock.calls[1])).toBe(7)
  })

  it('positionStaleRevision_AnotherDevice_OursWrittenOnceMoreOnTheirRevision', async () => {
    const s = open()
    await s.restore()
    api.putReadingState.mockRejectedValueOnce(conflict('stale_revision', state(9, 5, new Date(Date.now() + 60_000).toISOString())))
    s.store(entry(pos(2)))
    await s.flush()
    expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([null, 9])
    expect(statuses).toEqual(['saved'])
  })

  it('positionReset_WrittenAgainOnTheNewRevision', async () => {
    const s = open()
    await s.restore()
    api.putReadingState.mockRejectedValueOnce(conflict('reset', state(3)))
    s.store(entry(pos(2)))
    await s.flush()
    expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([null, 3])
  })

  it('positionLostTwice_UnsavedThenTheNextStoreRetries', async () => {
    const s = open()
    await s.restore()
    api.putReadingState.mockRejectedValueOnce(conflict('stale_revision', state(2))).mockRejectedValueOnce(conflict('stale_revision', state(3)))
    s.store(entry(pos(2)))
    await s.flush()
    expect(statuses).toEqual(['unsaved'])
    s.store(entry(pos(2)))
    await s.flush()
    expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([null, 2, 3])
    expect(statuses).toEqual(['unsaved', 'saved'])
  })

  it('offline_UnsavedThenFlushRetriesTheSameEntry', async () => {
    const s = open()
    await s.restore()
    api.putReadingState.mockRejectedValueOnce(new ApiError(0, 'offline'))
    s.store(entry(pos(2)))
    await s.flush()
    expect(statuses).toEqual(['unsaved'])
    await s.flush()
    expect(api.putReadingState).toHaveBeenCalledTimes(2)
    expect(statuses).toEqual(['unsaved', 'saved'])
  })

  it('cbzPage_NoWriteTheServerTakes_Unsaved', async () => {
    const s = open()
    await s.restore()
    s.store(entry({ cfi: cfi(1), page: 'p1.jpg', index: 1, fraction: 0.1, at: 1 }))
    await s.flush()
    expect(api.putReadingState).not.toHaveBeenCalled()
    expect(statuses).toEqual(['unsaved'])
  })

  it('highlight_NewThenEdited_CreateThenEditOnItsRevision', async () => {
    const s = open()
    await s.restore()
    s.store(entry(null, [hl()]))
    await s.flush()
    s.store(entry(null, [hl(H1, 'green')]))
    await s.flush()
    expect(api.putAnnotation.mock.calls.map((c) => [c[0], expectedOf(c), (c[1] as V2AnnotationWrite).color])).toEqual([[H1, null, 'yellow'], [H1, 1, 'green']])
  })

  it('highlightStale_AnotherDevice_ReappliedOnceOnTheirRevision', async () => {
    api.annotations.mockResolvedValue([annotation({ id: H1, revision: 2 })])
    const s = open()
    await s.restore()
    api.putAnnotation.mockRejectedValueOnce(conflict('stale_revision', annotation({ id: H1, revision: 5, color: 'blue' })))
    s.store(entry(null, [hl(H1, 'green')]))
    await s.flush()
    expect(api.putAnnotation.mock.calls.map(expectedOf)).toEqual([2, 5])
  })

  it('highlightDeletedElsewhere_TombstoneKept_NeverWrittenAgain', async () => {
    const s = open()
    await s.restore()
    api.putAnnotation.mockRejectedValueOnce(conflict('deleted', annotation({ id: H1, revision: 3, deletedAt: '2026-11-02T00:00:00Z' })))
    s.store(entry(null, [hl()]))
    await s.flush()
    s.store(entry(null, [hl(H1, 'green')]))
    await s.flush()
    expect(api.putAnnotation).toHaveBeenCalledTimes(1)
    expect(statuses[statuses.length - 1]).toBe('saved')
  })

  it('closedWhileAWriteIsInFlight_AnswerDropped_NothingMoreWrittenNoStatus', async () => {
    let land!: () => void
    api.putReadingState.mockImplementationOnce((_b: string, w: V2ReadingStateWrite) => new Promise((ok) => { land = () => ok(state(1)) ; void w }))
    const s = open()
    await s.restore()
    s.store(entry(pos(2), [hl()]))
    const done = s.flush()
    s.close()
    land()
    await done
    s.store(entry(pos(3)))
    await s.flush()
    expect(api.putReadingState).toHaveBeenCalledTimes(1)
    expect(api.putAnnotation).not.toHaveBeenCalled()
    expect(statuses).toEqual([])
  })

  it('closedBeforeRestoreAnswers_Null', async () => {
    let answer!: (s: V2ReadingState) => void
    api.getReadingState.mockReturnValue(new Promise((ok) => { answer = ok }))
    const s = open()
    const restored = s.restore()
    s.close()
    answer(state(1))
    expect(await restored).toBeNull()
  })

  it('accountResetMidWrite_ConflictNotRetried', async () => {
    const s = open()
    await s.restore()
    api.putReadingState.mockImplementationOnce(async () => {
      v2Store.reset()
      throw conflict('stale_revision', state(4))
    })
    s.store(entry(pos(2)))
    await s.flush()
    expect(api.putReadingState).toHaveBeenCalledTimes(1)
    expect(statuses).toEqual([])
  })

  it('storeDuringAPass_OneMorePassOnTheLatestEntry', async () => {
    let land!: () => void
    api.putReadingState.mockImplementationOnce(() => new Promise((ok) => { land = () => ok(state(1)) }))
    const s = open()
    await s.restore()
    s.store(entry(pos(2)))
    s.store(entry(pos(3)))
    s.store(entry(pos(4)))
    land()
    await s.flush()
    expect(api.putReadingState.mock.calls.map((c) => (c[1] as V2ReadingStateWrite).currentLocator.value)).toEqual([cfi(2), cfi(4)])
    expect(expectedOf(api.putReadingState.mock.calls[1])).toBe(1)
  })

  it('flushKeepalive_UnsavedPosition_KeepaliveWriteOnTheKnownRevision_SavedOneNot', async () => {
    api.getReadingState.mockResolvedValue(state(4, 1))
    const s = open()
    await s.restore()
    api.putReadingState.mockRejectedValueOnce(new ApiError(0, 'offline'))
    s.store(entry(pos(2)))
    await s.flush()
    s.flushKeepalive()
    expect(api.keepalivePutState).toHaveBeenCalledWith('b1', expect.objectContaining({ expectedRevision: 4 }))
    await s.flush()
    s.flushKeepalive()
    expect(api.keepalivePutState).toHaveBeenCalledTimes(1)
  })

  it('restore_StateOnAnotherFileVersion_NoPosition_FirstWriteOnThisFile', async () => {
    api.getReadingState.mockResolvedValue({ ...state(6, 2), fileId: 'old' })
    const s = open()
    expect(JSON.parse((await s.restore())!).position).toBeNull()
    s.store(entry(pos(3)))
    await s.flush()
    expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([null])
  })

  it('highlightLostTwice_TheServersKept_NoThirdWrite', async () => {
    const s = open()
    await s.restore()
    api.putAnnotation
      .mockRejectedValueOnce(conflict('stale_revision', annotation({ id: H1, revision: 5, color: 'blue' })))
      .mockRejectedValueOnce(conflict('stale_revision', annotation({ id: H1, revision: 6, color: 'red' })))
    s.store(entry(null, [hl()]))
    await s.flush()
    expect(api.putAnnotation.mock.calls.map(expectedOf)).toEqual([null, 5])
  })

  it('closedWhileAFailingWriteIsInFlight_NoStatus', async () => {
    let fail!: () => void
    api.putReadingState.mockImplementationOnce(() => new Promise((_ok, no) => { fail = () => no(new ApiError(0, 'offline')) }))
    const s = open()
    await s.restore()
    s.store(entry(pos(2)))
    const done = s.flush()
    s.close()
    fail()
    await done
    expect(statuses).toEqual([])
  })
})
