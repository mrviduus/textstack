import { ApiError, type PageHighlight, type PagePosition, type V2Annotation, type V2AnnotationWrite, type V2ReadingState, type V2ReadingStateWrite } from '@textstack/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { v2Store } from '../api/v2'
import { createV2ReaderSync, KEEPALIVE_BUDGET, v2ReaderSyncApi, type V2ReaderSyncApi, type V2SaveStatus, type V2SyncTarget } from './v2ReaderSync'

// #1226: the web V2 host's sync decisions against a fake server — restore (no read, no session), highlights after
// their pull (none written before it), diff, the 409 paths, terminal refusals, the stale-open and account guards,
// retry on the next store / flush, close's last pass, the keepalive writes, the CBZ local exception.

const T: V2SyncTarget = { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: 'ab'.repeat(32), size: 100, name: 'a.epub' }
const H1 = '11111111-1111-4111-8111-111111111111'
const H2 = '22222222-2222-4222-8222-222222222222'
const MINTED = '99999999-9999-4999-8999-999999999999'
const cfi = (n: number) => `epubcfi(/6/${2 * n + 2}!/4/2/1:0)`
const pos = (n: number, at = 1_000) => ({ cfi: cfi(n), quote: `quote ${n}`, index: n, fraction: n / 10, at })
const hl = (id = H1, color = 'yellow') => ({ id, cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)', index: 1, quote: 'Hello', selectedText: 'Hello', prefix: '', suffix: '', color, at: 1 })
const entry = (position: object | null, highlights: object[] = [], t: V2SyncTarget = T) =>
  JSON.stringify({ v: 1, book: { sha256: t.sha256, size: t.size, name: t.name }, position, highlights })

const state = (revision: number, n = 1, at = '2026-11-01T00:00:00.000Z'): V2ReadingState => ({
  bookId: T.bookId, fileId: T.fileId, currentLocator: { version: 1, scheme: 'epub-cfi', value: cfi(n), quote: `quote ${n}` },
  bookFraction: n / 10, frontierLocator: null, frontierFraction: null, completedAt: null, clientRecordedAt: at, updatedAt: at, revision, resetRevision: null,
})
const annotation = (w: Partial<V2Annotation> & { id: string }): V2Annotation => ({
  bookId: T.bookId, fileId: T.fileId, selectedText: 'Hello', noteText: null, color: 'yellow',
  locator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4/2,/1:0,/1:5)', quote: 'Hello' },
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', deletedAt: null, revision: 1, ...w,
})
const fail = (status: number, code: string, current: unknown = null) => Object.assign(new ApiError(status, code), { body: { code, message: code, current } })
const conflict = (code: string, current: unknown) => fail(409, code, current)
const offline = () => new ApiError(0, 'offline')
const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no })
  return { promise, resolve, reject }
}

let api: { [K in keyof V2ReaderSyncApi]: ReturnType<typeof vi.fn> }
let statuses: V2SaveStatus[]
let drawnLists: PageHighlight[][]
/** The places offered to the host (`onNewerPlace`). */
let newer: PagePosition[]
/** A write recorded before every other here. */
const OLD = '1970-01-01T00:00:00.000Z'

beforeEach(() => {
  localStorage.clear()
  statuses = []
  drawnLists = []
  newer = []
  api = {
    getReadingState: vi.fn().mockResolvedValue(null),
    annotations: vi.fn().mockResolvedValue([]),
    putReadingState: vi.fn(async (_b: string, w: V2ReadingStateWrite) => ({ ...state((w.expectedRevision ?? 0) + 1), currentLocator: w.currentLocator, clientRecordedAt: w.clientRecordedAt })),
    putAnnotation: vi.fn(async (id: string, w: V2AnnotationWrite) => annotation({ id, color: w.color, revision: (w.expectedRevision ?? 0) + 1 })),
    keepalivePutState: vi.fn(),
    keepalivePutAnnotation: vi.fn(),
  }
})

const open = (t: V2SyncTarget = T, after?: Promise<unknown>, highlights?: boolean) => createV2ReaderSync(t, {
  api: api as unknown as V2ReaderSyncApi, onStatus: (s) => statuses.push(s), onHighlights: (l) => drawnLists.push(l),
  onNewerPlace: (p) => newer.push(p), newId: () => MINTED, after, highlights,
})
const expectedOf = (call: unknown[]) => (call[1] as { expectedRevision: number | null }).expectedRevision
const last = () => statuses[statuses.length - 1]
async function opened(t: V2SyncTarget = T) {
  const s = open(t)
  await s.restore()
  await s.loadHighlights()
  return s
}
async function stored(s: ReturnType<typeof open>, json: string) {
  s.store(json)
  await s.flush()
}

describe('createV2ReaderSync', () => {
  describe('restore', () => {
    it('restore_PositionFromTheReadingState_HighlightsWhenThePullLandsThisFilesLiveOnly', async () => {
      api.getReadingState.mockResolvedValue(state(4, 2))
      const pull = deferred<V2Annotation[]>()
      api.annotations.mockReturnValue(pull.promise)
      const s = open()
      const e = JSON.parse((await s.restore())!)
      const loading = s.loadHighlights()
      // The position does not wait for the annotations pull.
      expect(e.position).toMatchObject({ cfi: cfi(2), quote: 'quote 2', index: 2, fraction: 0.2 })
      expect(e.highlights).toEqual([])
      expect(e.book).toEqual({ sha256: T.sha256, size: T.size, name: T.name })
      pull.resolve([
        annotation({ id: H1 }),
        annotation({ id: H2, deletedAt: '2026-11-02T00:00:00Z' }),
        annotation({ id: '33333333-3333-4333-8333-333333333333', fileId: 'old' }),
        annotation({ id: '44444444-4444-4444-8444-444444444444', bookId: 'other' }),
      ])
      await loading
      expect(drawnLists.map((l) => l.map((h) => h.id))).toEqual([[H1]])
    })

    it('restore_StateOnAnotherFileVersion_NoPosition_FirstWriteOnThisFile', async () => {
      api.getReadingState.mockResolvedValue({ ...state(6, 2), fileId: 'old' })
      const s = open()
      expect(JSON.parse((await s.restore())!).position).toBeNull()
      await stored(s, entry(pos(3)))
      expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([null])
    })

    it('restore_WaitsForThePreviousSessionsWrites', async () => {
      const prior = deferred<void>()
      const s = open(T, prior.promise)
      const restored = s.restore()
      await Promise.resolve()
      expect(api.getReadingState).not.toHaveBeenCalled()
      prior.resolve()
      await restored
      expect(api.getReadingState).toHaveBeenCalledTimes(1)
    })

    it('closedWhileWaitingForThePreviousSession_NothingRead', async () => {
      const prior = deferred<void>()
      const s = open(T, prior.promise)
      const restored = s.restore()
      void s.close()
      prior.resolve()
      expect(await restored).toBeNull()
      expect(api.getReadingState).not.toHaveBeenCalled()
    })

    it('closedBeforeRestoreAnswers_Null', async () => {
      const read = deferred<V2ReadingState>()
      api.getReadingState.mockReturnValue(read.promise)
      const s = open()
      const restored = s.restore()
      await vi.waitFor(() => expect(api.getReadingState).toHaveBeenCalled())
      void s.close()
      read.resolve(state(1))
      expect(await restored).toBeNull()
    })
  })

  describe('no read, no session', () => {
    it('readFails_RestoreThrows_NothingEverWritten', async () => {
      api.getReadingState.mockRejectedValue(offline())
      const s = open()
      await expect(s.restore()).rejects.toThrow()
      s.store(entry(pos(2), [hl()]))
      await s.flush()
      s.flushKeepalive()
      await s.close()
      expect(api.putReadingState).not.toHaveBeenCalled()
      expect(api.putAnnotation).not.toHaveBeenCalled()
      expect(api.keepalivePutState).not.toHaveBeenCalled()
      expect(api.getReadingState).toHaveBeenCalledTimes(1)
      expect(statuses).toEqual([])
    })

    it('retryAfterAFailedRead_RestoresTheServersPlace_ThenWritesOnItsRevision', async () => {
      api.getReadingState.mockRejectedValueOnce(offline()).mockResolvedValueOnce(state(7, 5))
      const s = open()
      await expect(s.restore()).rejects.toThrow()
      expect(JSON.parse((await s.restore())!).position).toMatchObject({ cfi: cfi(5) })
      await s.loadHighlights()
      await stored(s, entry(pos(6)))
      expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([7])
    })
  })

  describe('annotations pull', () => {
    it('closed_NoPull', async () => {
      const s = open()
      await s.restore()
      await s.close()
      await s.loadHighlights()
      expect(api.annotations).not.toHaveBeenCalled()
    })

    it('pullLandsWhileClosing_NotDrawn', async () => {
      const pull = deferred<V2Annotation[]>()
      api.annotations.mockReturnValueOnce(pull.promise)
      const s = open()
      await s.restore()
      s.store(entry(pos(2)))
      const closed = s.close()
      pull.resolve([annotation({ id: H1 })])
      await closed
      expect(drawnLists).toEqual([])
    })

    it('defaultPull_FreshEachTime_NeverJoinsOneInFlight', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], cursor: null, hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      vi.stubGlobal('fetch', fetchMock)
      try {
        await Promise.all([v2ReaderSyncApi.annotations(), v2ReaderSyncApi.annotations()])
        expect(fetchMock).toHaveBeenCalledTimes(2)
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('pullFails_NoHighlights_PositionStillWritten_HighlightHeld_ThenRetriedDrawnAndWritten', async () => {
      api.annotations.mockRejectedValueOnce(offline()).mockRejectedValueOnce(offline())
      const s = open()
      await s.restore()
      await s.loadHighlights()
      expect(statuses).toEqual(['noHighlights'])
      expect(drawnLists).toEqual([])
      await stored(s, entry(pos(2), [hl()]))
      expect(api.putReadingState).toHaveBeenCalledTimes(1)
      expect(api.putAnnotation).not.toHaveBeenCalled()
      s.flushKeepalive()
      expect(api.keepalivePutAnnotation).not.toHaveBeenCalled()
      expect(statuses[statuses.length - 1]).toBe('noHighlights')
      // The next flush pulls again: drawn, then the held highlight is written by one more pass.
      await s.flush()
      await vi.waitFor(() => expect(statuses[statuses.length - 1]).toBe('saved'))
      expect(drawnLists).toEqual([[]])
      expect(api.putAnnotation).toHaveBeenCalledTimes(1)
    })

    it('pullHangs_PositionWrittenAndCloseEnds_NeitherWaitsForIt', async () => {
      api.annotations.mockReturnValue(new Promise(() => {}))
      const s = open()
      await s.restore()
      void s.loadHighlights()
      await stored(s, entry(pos(2)))
      expect(api.putReadingState).toHaveBeenCalledTimes(1)
      await s.close()
    })

    it('pullFailed_FlushBeforeAnyStore_PullsAgain', async () => {
      api.annotations.mockRejectedValueOnce(offline())
      const s = open()
      await s.restore()
      await s.loadHighlights()
      await s.flush()
      await vi.waitFor(() => expect(drawnLists).toEqual([[]]))
      expect(api.annotations).toHaveBeenCalledTimes(2)
    })

    it('bookWithoutHighlights_NoPull_PositionSaved', async () => {
      const s = open(T, undefined, false)
      await s.restore()
      await s.loadHighlights()
      await stored(s, entry(pos(2)))
      expect(api.annotations).not.toHaveBeenCalled()
      expect(statuses).toEqual(['saved'])
    })

    it('reopenAfterAnotherBook_ReadsAfterTheOldSessionsLastWrite', async () => {
      const a1 = await opened()
      const put = deferred<V2ReadingState>()
      api.putReadingState.mockReturnValueOnce(put.promise)
      a1.store(entry(pos(2)))
      void a1.close()
      const b = await opened({ ...T, bookId: 'b2' })
      void b.close()
      const read = open().restore()
      await Promise.resolve()
      expect(api.getReadingState.mock.calls.filter((c) => c[0] === T.bookId)).toHaveLength(1)
      put.resolve(state(1, 2))
      await read
      expect(api.getReadingState.mock.calls.filter((c) => c[0] === T.bookId)).toHaveLength(2)
    })
  })

  describe('position', () => {
    it('store_PositionMoved_WrittenOnTheRestoredRevision_SameAgainNotWritten', async () => {
      api.getReadingState.mockResolvedValue(state(4, 1))
      const s = await opened()
      await stored(s, entry(pos(1, 5)))
      await stored(s, entry(pos(3)))
      expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([4, 5])
      await stored(s, entry(pos(3)))
      expect(api.putReadingState).toHaveBeenCalledTimes(2)
      expect(last()).toBe('saved')
    })

    it('store_NotThisBooksEntry_NothingWritten', async () => {
      const s = await opened()
      s.store(entry(pos(2)).replace(T.sha256, 'cd'.repeat(32)))
      s.store('{not json')
      await s.flush()
      expect(api.putReadingState).not.toHaveBeenCalled()
    })

    it('staleRevision_OwnWriteLost_AcceptedNoRetry', async () => {
      const s = await opened()
      api.putReadingState.mockImplementationOnce(async (_b: string, w: V2ReadingStateWrite) => {
        throw conflict('stale_revision', { ...state(7), currentLocator: w.currentLocator, clientRecordedAt: w.clientRecordedAt })
      })
      await stored(s, entry(pos(2)))
      expect(api.putReadingState).toHaveBeenCalledTimes(1)
      await stored(s, entry(pos(3)))
      expect(expectedOf(api.putReadingState.mock.calls[1])).toBe(7)
    })

    // #1232: ADR-019 by decideServerState on a lost write, as Android: against the place this tab last saved or restored.
    describe('another device wrote meanwhile', () => {
      const theirs = (n: number) => expect.objectContaining({ cfi: cfi(n), index: n })
      const sent = () => api.putReadingState.mock.calls.map((c) => [(c[1] as V2ReadingStateWrite).currentLocator.value, expectedOf(c)])
      const SAVED_AT = Date.parse('2026-01-01T00:00:00.000Z')
      const BETWEEN = '2026-02-01T00:00:00.000Z'
      /** pos(2) saved (revision 5, recorded at SAVED_AT); the next move loses to `server`. */
      async function savedThenLost(...server: V2ReadingState[]) {
        api.getReadingState.mockResolvedValue(state(4, 1, OLD))
        const s = await opened()
        await stored(s, entry(pos(2, SAVED_AT)))
        for (const st of server) api.putReadingState.mockRejectedValueOnce(conflict('stale_revision', st))
        // The move now is the newest of all: the rule never weighs it.
        await stored(s, entry(pos(3, Date.now() + 120_000)))
        return s
      }

      it('theirsNewerThanOurLastSave_OursWrittenOnTheirRevision_TheirsOffered', async () => {
        await savedThenLost(state(9, 5, BETWEEN))
        expect(sent()).toEqual([[cfi(2), 4], [cfi(3), 5], [cfi(3), 9]])
        expect(newer).toEqual([theirs(5)])
        expect(last()).toBe('saved')
      })

      it('nothingSavedYet_TheRestoredPlaceIsOurs', async () => {
        api.getReadingState.mockResolvedValue(state(4, 1, OLD))
        const s = await opened()
        api.putReadingState.mockRejectedValueOnce(conflict('stale_revision', state(9, 5, BETWEEN)))
        await stored(s, entry(pos(3, Date.now() + 120_000)))
        expect(newer).toEqual([theirs(5)])
        expect(sent()).toEqual([[cfi(3), 4], [cfi(3), 9]])
      })

      it('theirsOlderThanOurLastSave_OursWritten_NothingOffered', async () => {
        await savedThenLost(state(9, 5, OLD))
        expect(sent()).toEqual([[cfi(2), 4], [cfi(3), 5], [cfi(3), 9]])
        expect(newer).toEqual([])
      })

      it('lostAgain_TheNewestOffered', async () => {
        await savedThenLost(state(9, 5, BETWEEN), state(10, 6, BETWEEN))
        expect(newer).toEqual([theirs(5), theirs(6)])
        expect(sent()).toEqual([[cfi(2), 4], [cfi(3), 5], [cfi(3), 9]])
        expect(last()).toBe('unsaved')
      })

      it('ourPreviousWriteLandedItsAnswerLost_OursRewritten_NothingOffered', async () => {
        api.getReadingState.mockResolvedValue(state(4, 1, OLD))
        const s = await opened()
        // pos(2) lands (revision 5) but its answer is lost: this tab still holds pos(1) as saved.
        api.putReadingState.mockRejectedValueOnce(offline())
        await stored(s, entry(pos(2, SAVED_AT)))
        const landed = api.putReadingState.mock.calls[0][1] as V2ReadingStateWrite
        api.putReadingState.mockRejectedValueOnce(conflict('stale_revision',
          { ...state(5), currentLocator: landed.currentLocator, clientRecordedAt: landed.clientRecordedAt }))
        await stored(s, entry(pos(3, Date.now() + 120_000)))
        expect(newer).toEqual([])
        expect(sent()).toEqual([[cfi(2), 4], [cfi(3), 4], [cfi(3), 5]])
        expect(last()).toBe('saved')
      })

      it('closing_TheHostToldNothing_OursStillWrittenOnTheirRevision', async () => {
        api.getReadingState.mockResolvedValue(state(4, 1, OLD))
        const s = await opened()
        await stored(s, entry(pos(2, SAVED_AT)))
        const put = deferred<V2ReadingState>()
        api.putReadingState.mockReturnValueOnce(put.promise)
        s.store(entry(pos(3, Date.now() + 120_000)))
        const closing = s.close()
        put.reject(conflict('stale_revision', state(9, 5, BETWEEN)))
        await closing
        expect(newer).toEqual([])
        expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([4, 5, 9])
      })
    })

    it('reset_WrittenAgainOnTheNewRevision', async () => {
      const s = await opened()
      api.putReadingState.mockRejectedValueOnce(conflict('reset', state(3)))
      await stored(s, entry(pos(2)))
      expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([null, 3])
    })

    it('lostTwice_UnsavedThenTheNextStoreRetriesOnTheLastRevision', async () => {
      const s = await opened()
      api.putReadingState.mockRejectedValueOnce(conflict('stale_revision', state(2))).mockRejectedValueOnce(conflict('stale_revision', state(3)))
      await stored(s, entry(pos(2)))
      expect(statuses).toEqual(['unsaved'])
      await stored(s, entry(pos(2)))
      expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([null, 2, 3])
      expect(statuses).toEqual(['unsaved', 'saved'])
    })

    it('offline_UnsavedThenFlushRetriesTheSameEntry', async () => {
      const s = await opened()
      api.putReadingState.mockRejectedValueOnce(offline())
      await stored(s, entry(pos(2)))
      expect(statuses).toEqual(['unsaved'])
      await s.flush()
      expect(api.putReadingState).toHaveBeenCalledTimes(2)
      expect(statuses).toEqual(['unsaved', 'saved'])
    })

    it.each(['file_replaced', 'unknown_file', 'book_not_found'])('%s_Reopen_NoRequestOnLaterStores', async (code) => {
      const s = await opened()
      api.putReadingState.mockRejectedValueOnce(conflict(code, null))
      await stored(s, entry(pos(2), [hl()]))
      expect(statuses).toEqual(['reopen'])
      await stored(s, entry(pos(3), [hl(H1, 'green')]))
      expect(api.putReadingState).toHaveBeenCalledTimes(1)
      expect(api.putAnnotation).not.toHaveBeenCalled()
      s.flushKeepalive()
      expect(api.keepalivePutState).not.toHaveBeenCalled()
    })

    it('invalidPayload_UnsavedNotResent_UntilTheReaderMoves', async () => {
      const s = await opened()
      api.putReadingState.mockRejectedValueOnce(fail(400, 'invalid_payload'))
      await stored(s, entry(pos(2)))
      await stored(s, entry(pos(2)))
      expect(api.putReadingState).toHaveBeenCalledTimes(1)
      expect(statuses).toEqual(['unsaved', 'unsaved'])
      await stored(s, entry(pos(3)))
      expect(api.putReadingState).toHaveBeenCalledTimes(2)
      expect(last()).toBe('saved')
    })
  })

  describe('cbz (#1188: local only)', () => {
    const CBZ: V2SyncTarget = { ...T, format: 'cbz' }
    const page = (name: string) => ({ cfi: cfi(1), page: name, index: 1, fraction: 0.1, at: 1 })

    it('imagePage_KeptInThisBrowser_NeverPut_Saved_RestoredOnTheNextOpen', async () => {
      const s = await opened(CBZ)
      await stored(s, entry(page('p3.jpg'), [], CBZ))
      expect(api.putReadingState).not.toHaveBeenCalled()
      expect(statuses).toEqual(['saved'])
      const again = open(CBZ)
      expect(JSON.parse((await again.restore())!).position).toEqual(page('p3.jpg'))
      expect(JSON.parse((await open().restore())!).position).toBeNull()
    })

    it('tabGoingAway_APassStillRunning_TheLatestImagePageIsKept', async () => {
      const s = await opened(CBZ)
      s.store(entry(page('p3.jpg'), [], CBZ))
      s.store(entry(page('p4.jpg'), [], CBZ))
      s.flushKeepalive()
      expect(JSON.parse(localStorage.getItem(`v2reader:cbz-position:${CBZ.bookId}`)!)).toEqual(page('p4.jpg'))
    })
  })

  describe('highlights', () => {
    it('newThenEdited_CreateThenEditOnItsRevision', async () => {
      const s = await opened()
      await stored(s, entry(null, [hl()]))
      await stored(s, entry(null, [hl(H1, 'green')]))
      expect(api.putAnnotation.mock.calls.map((c) => [c[0], expectedOf(c), (c[1] as V2AnnotationWrite).color])).toEqual([[H1, null, 'yellow'], [H1, 1, 'green']])
    })

    it('staleAnotherDevice_ReappliedOnceOnTheirRevision', async () => {
      api.annotations.mockResolvedValue([annotation({ id: H1, revision: 2 })])
      const s = await opened()
      api.putAnnotation.mockRejectedValueOnce(conflict('stale_revision', annotation({ id: H1, revision: 5, color: 'blue' })))
      await stored(s, entry(null, [hl(H1, 'green')]))
      expect(api.putAnnotation.mock.calls.map(expectedOf)).toEqual([2, 5])
    })

    it('lostTwice_TheServersKept_TheSamePageFormNotWrittenAgain_AChangeIs', async () => {
      const s = await opened()
      api.putAnnotation
        .mockRejectedValueOnce(conflict('stale_revision', annotation({ id: H1, revision: 5, color: 'blue' })))
        .mockRejectedValueOnce(conflict('stale_revision', annotation({ id: H1, revision: 6, color: 'red' })))
      await stored(s, entry(null, [hl()]))
      expect(api.putAnnotation.mock.calls.map(expectedOf)).toEqual([null, 5])
      // The page still shows ours and saves it again (a page turn): the server's stays.
      await stored(s, entry(pos(2), [hl()]))
      expect(api.putAnnotation).toHaveBeenCalledTimes(2)
      // The reader changes it: that is written, on the server's revision.
      await stored(s, entry(pos(2), [hl(H1, 'green')]))
      expect(api.putAnnotation.mock.calls.map(expectedOf)).toEqual([null, 5, 6])
    })

    it('deletedElsewhere_TombstoneKept_NeverWrittenAgain', async () => {
      const s = await opened()
      api.putAnnotation.mockRejectedValueOnce(conflict('deleted', annotation({ id: H1, revision: 3, deletedAt: '2026-11-02T00:00:00Z' })))
      await stored(s, entry(null, [hl()]))
      await stored(s, entry(null, [hl(H1, 'green')]))
      expect(api.putAnnotation).toHaveBeenCalledTimes(1)
      expect(last()).toBe('saved')
    })

    it('idConflict_ReKeyedOnce_ThePagesOldIdNotSentAgain', async () => {
      const s = await opened()
      api.putAnnotation.mockRejectedValueOnce(conflict('id_conflict', null))
      await stored(s, entry(null, [hl()]))
      expect(api.putAnnotation.mock.calls.map((c) => [c[0], expectedOf(c)])).toEqual([[H1, null], [MINTED, null]])
      await stored(s, entry(pos(2), [hl()]))
      expect(api.putAnnotation).toHaveBeenCalledTimes(2)
    })

    it('idConflictTwice_UnsavedNotResentUntilChanged', async () => {
      const s = await opened()
      api.putAnnotation.mockRejectedValueOnce(conflict('id_conflict', null)).mockRejectedValueOnce(conflict('id_conflict', null))
      await stored(s, entry(null, [hl()]))
      await stored(s, entry(pos(2), [hl()]))
      expect(api.putAnnotation).toHaveBeenCalledTimes(2)
      expect(last()).toBe('unsaved')
    })

    it('invalidPayload_UnsavedNotResent_UntilChanged', async () => {
      const s = await opened()
      api.putAnnotation.mockRejectedValueOnce(fail(400, 'invalid_payload'))
      await stored(s, entry(null, [hl()]))
      await stored(s, entry(pos(2), [hl()]))
      expect(api.putAnnotation).toHaveBeenCalledTimes(1)
      expect(statuses).toEqual(['unsaved', 'unsaved'])
      await stored(s, entry(pos(2), [hl(H1, 'green')]))
      expect(api.putAnnotation).toHaveBeenCalledTimes(2)
      expect(last()).toBe('saved')
    })

    it('bookNotFound_Reopen_NoMoreRequests', async () => {
      const s = await opened()
      api.putAnnotation.mockRejectedValueOnce(fail(404, 'book_not_found'))
      await stored(s, entry(null, [hl(), hl(H2)]))
      expect(api.putAnnotation).toHaveBeenCalledTimes(1)
      expect(statuses).toEqual(['reopen'])
    })
  })

  describe('guards and passes', () => {
    it('close_TheUnsavedWriteGoesOut_ThenNothingMoreAndNoStatus', async () => {
      const s = await opened()
      api.putReadingState.mockRejectedValueOnce(offline())
      await stored(s, entry(pos(2)))
      expect(statuses).toEqual(['unsaved'])
      await s.close()
      expect(api.putReadingState).toHaveBeenCalledTimes(2)
      expect(statuses).toEqual(['unsaved'])
      await stored(s, entry(pos(3)))
      expect(api.putReadingState).toHaveBeenCalledTimes(2)
    })

    it('closeDuringAPass_AStoreQueuedBeforeIsWritten', async () => {
      const put = deferred<V2ReadingState>()
      api.putReadingState.mockReturnValueOnce(put.promise)
      const s = await opened()
      s.store(entry(pos(2)))
      s.store(entry(pos(3)))
      const closed = s.close()
      put.resolve(state(1))
      await closed
      expect(api.putReadingState.mock.calls.map((c) => (c[1] as V2ReadingStateWrite).currentLocator.value)).toEqual([cfi(2), cfi(3)])
      expect(statuses).toEqual([])
    })

    it('storeWhileClosing_NotWritten', async () => {
      const put = deferred<V2ReadingState>()
      api.putReadingState.mockReturnValueOnce(put.promise)
      const s = await opened()
      s.store(entry(pos(2)))
      const closed = s.close()
      s.store(entry(pos(5)))
      put.resolve(state(1))
      await closed
      expect(api.putReadingState).toHaveBeenCalledTimes(1)
    })

    it('closedWhileAFailingWriteIsInFlight_NoStatus', async () => {
      const put = deferred<V2ReadingState>()
      api.putReadingState.mockReturnValueOnce(put.promise)
      const s = await opened()
      s.store(entry(pos(2)))
      const closed = s.close()
      put.reject(offline())
      await closed
      expect(statuses).toEqual([])
    })

    it('accountResetMidWrite_ConflictNotRetried', async () => {
      const s = await opened()
      api.putReadingState.mockImplementationOnce(async () => {
        v2Store.reset()
        throw conflict('stale_revision', state(4))
      })
      await stored(s, entry(pos(2)))
      expect(api.putReadingState).toHaveBeenCalledTimes(1)
      expect(statuses).toEqual([])
    })

    it('storeDuringAPass_OneMorePassOnTheLatestEntry', async () => {
      const put = deferred<V2ReadingState>()
      api.putReadingState.mockReturnValueOnce(put.promise)
      const s = await opened()
      s.store(entry(pos(2)))
      s.store(entry(pos(3)))
      s.store(entry(pos(4)))
      put.resolve(state(1))
      await s.flush()
      expect(api.putReadingState.mock.calls.map((c) => (c[1] as V2ReadingStateWrite).currentLocator.value)).toEqual([cfi(2), cfi(4)])
      expect(expectedOf(api.putReadingState.mock.calls[1])).toBe(1)
    })
  })

  describe('flushKeepalive', () => {
    it('unsavedPositionAndHighlight_SentOnTheKnownRevisions_SavedOnesNot', async () => {
      api.getReadingState.mockResolvedValue(state(4, 1))
      const s = await opened()
      api.putReadingState.mockRejectedValueOnce(offline())
      api.putAnnotation.mockRejectedValueOnce(offline())
      await stored(s, entry(pos(2), [hl()]))
      s.flushKeepalive()
      expect(api.keepalivePutState).toHaveBeenCalledTimes(1)
      expect(JSON.parse(api.keepalivePutState.mock.calls[0][1])).toMatchObject({ expectedRevision: 4 })
      expect(api.keepalivePutAnnotation.mock.calls.map((c) => [c[0], JSON.parse(c[1]).expectedRevision])).toEqual([[H1, null]])
      await s.flush()
      s.flushKeepalive()
      expect(api.keepalivePutState).toHaveBeenCalledTimes(1)
      expect(api.keepalivePutAnnotation).toHaveBeenCalledTimes(1)
    })

    it('overTheBudget_PositionFirst_HighlightsUntilItRunsOut', async () => {
      const s = await opened()
      api.putReadingState.mockRejectedValue(offline())
      api.putAnnotation.mockRejectedValue(offline())
      // 20 highlights of ~4 KB (the selection cap is 4000 UTF-16 units): over the budget together.
      const big = (n: number) => ({ ...hl(`${String(n).padStart(8, '0')}${H1.slice(8)}`), cfi: `epubcfi(/6/${2 * n + 4}!/4/2,/1:0,/1:5)`, selectedText: 'x'.repeat(3990) })
      const many = Array.from({ length: 20 }, (_, i) => big(i + 1))
      await stored(s, entry(pos(2), many))
      s.flushKeepalive()
      expect(api.keepalivePutState).toHaveBeenCalledTimes(1)
      const k = api.keepalivePutAnnotation.mock.calls.length
      expect(k).toBeGreaterThan(5)
      expect(k).toBeLessThan(20)
      const sent = [...api.keepalivePutState.mock.calls, ...api.keepalivePutAnnotation.mock.calls].reduce((n, c) => n + new TextEncoder().encode(c[1]).length, 0)
      expect(sent).toBeLessThanOrEqual(KEEPALIVE_BUDGET)
    })
  })
})
