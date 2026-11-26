import { ApiError, type PageHighlight, type PagePosition, type PageQuotation, type Annotation, type AnnotationWrite, type ReadingState, type ReadingStateWrite } from '@textstack/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syncStore } from '../api/sync'
import { createReaderSync, KEEPALIVE_BUDGET, readerSyncApi, type ReaderSyncApi, type SaveStatus, type SyncTarget } from './readerSync'

// #1226: the web V2 host's sync decisions against a fake server — restore (no read, no session), highlights after
// their pull (none written before it), diff, the 409 paths, terminal refusals, the stale-open and account guards,
// retry on the next store / flush, close's last pass, the keepalive writes, a CBZ page as `page-name` (#1188).

const T: SyncTarget = { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: 'ab'.repeat(32), size: 100, name: 'a.epub' }
const H1 = '11111111-1111-4111-8111-111111111111'
const H2 = '22222222-2222-4222-8222-222222222222'
const MINTED = '99999999-9999-4999-8999-999999999999'
const cfi = (n: number) => `epubcfi(/6/${2 * n + 2}!/4/2/1:0)`
const pos = (n: number, at = 1_000) => ({ cfi: cfi(n), quote: `quote ${n}`, index: n, fraction: n / 10, at })
const hl = (id = H1, color = 'yellow') => ({ id, cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:5)', index: 1, quote: 'Hello', selectedText: 'Hello', prefix: '', suffix: '', color, at: 1 })
const entry = (position: object | null, highlights: object[] = [], t: SyncTarget = T) =>
  JSON.stringify({ v: 1, book: { sha256: t.sha256, size: t.size, name: t.name }, position, highlights })

const state = (revision: number, n = 1, at = '2026-11-01T00:00:00.000Z'): ReadingState => ({
  bookId: T.bookId, fileId: T.fileId, currentLocator: { version: 1, scheme: 'epub-cfi', value: cfi(n), quote: `quote ${n}` },
  bookFraction: n / 10, frontierLocator: null, frontierFraction: null, completedAt: null, clientRecordedAt: at, updatedAt: at, revision, resetRevision: null,
})
const annotation = (w: Partial<Annotation> & { id: string }): Annotation => ({
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

let api: { [K in keyof ReaderSyncApi]: ReturnType<typeof vi.fn> }
let statuses: SaveStatus[]
let drawnLists: (PageHighlight | PageQuotation)[][]
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
    putReadingState: vi.fn(async (_b: string, w: ReadingStateWrite) => ({ ...state((w.expectedRevision ?? 0) + 1), currentLocator: w.currentLocator, clientRecordedAt: w.clientRecordedAt })),
    putAnnotation: vi.fn(async (id: string, w: AnnotationWrite) => annotation({ id, color: w.color, noteText: w.noteText ?? null, revision: (w.expectedRevision ?? 0) + 1 })),
    deleteAnnotation: vi.fn(async (id: string) => annotation({ id, deletedAt: '2026-11-03T00:00:00.000Z', revision: 9 })),
    keepalivePutState: vi.fn(),
    keepalivePutAnnotation: vi.fn(),
    keepaliveDeleteAnnotation: vi.fn(),
  }
})

const open = (t: SyncTarget = T, after?: Promise<unknown>, highlights?: boolean, bookmarksOnly?: boolean) => createReaderSync(t, {
  api: api as unknown as ReaderSyncApi, onStatus: (s) => statuses.push(s), onHighlights: (l) => drawnLists.push(l),
  onNewerPlace: (p) => newer.push(p), newId: () => MINTED, after, highlights, bookmarksOnly,
})
const expectedOf = (call: unknown[]) => (call[1] as { expectedRevision: number | null }).expectedRevision
const last = () => statuses[statuses.length - 1]
async function opened(t: SyncTarget = T) {
  const s = open(t)
  await s.restore()
  await s.loadHighlights()
  return s
}
async function stored(s: ReturnType<typeof open>, json: string) {
  s.store(json)
  await s.flush()
}

describe('createReaderSync', () => {
  describe('restore', () => {
    it('restore_PositionFromTheReadingState_HighlightsWhenThePullLandsThisFilesLiveOnly', async () => {
      api.getReadingState.mockResolvedValue(state(4, 2))
      const pull = deferred<Annotation[]>()
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
      const read = deferred<ReadingState>()
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
      const pull = deferred<Annotation[]>()
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
        await Promise.all([readerSyncApi.annotations(), readerSyncApi.annotations()])
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

    it('pullFails_OnABookmarksOnlyBook_NoHighlightsStatus_PositionSaved', async () => {
      // #1350: a PDF or a CBZ pulls for its bookmarks; it has no highlighting to say is missing.
      api.annotations.mockRejectedValueOnce(offline())
      const s = open(T, undefined, true, true)
      await s.restore()
      await s.loadHighlights()
      await stored(s, entry(pos(2), []))
      expect(api.putReadingState).toHaveBeenCalledTimes(1)
      expect(statuses).not.toContain('noHighlights')
      expect(last()).toBe('saved')
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
      const put = deferred<ReadingState>()
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
      api.putReadingState.mockImplementationOnce(async (_b: string, w: ReadingStateWrite) => {
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
      const sent = () => api.putReadingState.mock.calls.map((c) => [(c[1] as ReadingStateWrite).currentLocator.value, expectedOf(c)])
      const SAVED_AT = Date.parse('2026-01-01T00:00:00.000Z')
      const BETWEEN = '2026-02-01T00:00:00.000Z'
      /** pos(2) saved (revision 5, recorded at SAVED_AT); the next move loses to `server`. */
      async function savedThenLost(...server: ReadingState[]) {
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
        const landed = api.putReadingState.mock.calls[0][1] as ReadingStateWrite
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
        const put = deferred<ReadingState>()
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

  describe('cbz (#1188: page-name)', () => {
    const CBZ: SyncTarget = { ...T, format: 'cbz' }
    const page = (name: string, index = 1) => ({ cfi: cfi(index).replace(/!.*/, ')'), page: name, index, fraction: 0.1, at: 1 })
    const pageName = (name: string, index = 1) => ({ version: 1, scheme: 'page-name', value: { page: name, index } })

    it('imagePage_PutAsPageName_Saved_RestoredFromTheServerOnTheNextOpen', async () => {
      const s = await opened(CBZ)
      await stored(s, entry(page('p3.jpg'), [], CBZ))
      expect(api.putReadingState.mock.calls.map((c) => [expectedOf(c), (c[1] as ReadingStateWrite).currentLocator])).toEqual([[null, pageName('p3.jpg')]])
      expect(statuses).toEqual(['saved'])
      expect(localStorage.length).toBe(0)
      api.getReadingState.mockResolvedValue({ ...state(1), currentLocator: pageName('p3.jpg'), bookFraction: 0.1 })
      expect(JSON.parse((await open(CBZ).restore())!).position).toMatchObject({ cfi: 'epubcfi(/6/4)', page: 'p3.jpg', index: 1, fraction: 0.1 })
    })

    it('restoredImagePage_NotWrittenBack_UntilTheReaderMoves', async () => {
      api.getReadingState.mockResolvedValue({ ...state(2), currentLocator: pageName('p3.jpg'), bookFraction: 0.1 })
      const s = open(CBZ)
      const restored = JSON.parse((await s.restore())!).position
      await stored(s, entry(restored, [], CBZ))
      expect(api.putReadingState).not.toHaveBeenCalled()
      await stored(s, entry(page('p4.jpg', 2), [], CBZ))
      expect(api.putReadingState.mock.calls.map((c) => [expectedOf(c), (c[1] as ReadingStateWrite).currentLocator])).toEqual([[2, pageName('p4.jpg', 2)]])
    })

    it('tabGoingAway_TheLatestImagePageGoesByKeepalive', async () => {
      const s = await opened(CBZ)
      s.store(entry(page('p3.jpg'), [], CBZ))
      s.store(entry(page('p4.jpg', 2), [], CBZ))
      s.flushKeepalive()
      expect(api.keepalivePutState.mock.calls.map((c) => JSON.parse(c[1] as string).currentLocator)).toEqual([pageName('p4.jpg', 2)])
    })

    it('namedPageOnABookThatIsNeitherCbzNorEpub_NeverPut', async () => {
      const MOBI: SyncTarget = { ...T, format: 'mobi' }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const s = await opened(MOBI)
      await stored(s, entry(page('p3.jpg'), [], MOBI))
      expect(api.putReadingState).not.toHaveBeenCalled()
      // Not silent (#1196 review): the reason, never the key.
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(['[v2 sync] page position not synced (mobi): a named page does not fit a mobi file'])
      warn.mockRestore()
    })

    // #1196: a pre-paginated EPUB's page goes as page-name (its spine href); a reflowable EPUB's place stays epub-cfi.
    it('prePaginatedEpubPage_PutAsPageName_ReflowablePositionAsEpubCfi', async () => {
      const s = await opened()
      await stored(s, entry(page('OEBPS/p2.xhtml'), []))
      await stored(s, entry(pos(3), []))
      expect(api.putReadingState.mock.calls.map((c) => (c[1] as ReadingStateWrite).currentLocator.scheme)).toEqual(['page-name', 'epub-cfi'])
      expect((api.putReadingState.mock.calls[0][1] as ReadingStateWrite).currentLocator).toEqual(pageName('OEBPS/p2.xhtml'))
      api.getReadingState.mockResolvedValue({ ...state(2), currentLocator: pageName('OEBPS/p2.xhtml'), bookFraction: 0.1 })
      expect(JSON.parse((await open(T).restore())!).position).toMatchObject({ page: 'OEBPS/p2.xhtml', index: 1 })
    })
  })

  describe('highlights', () => {
    it('newThenEdited_CreateThenEditOnItsRevision', async () => {
      const s = await opened()
      await stored(s, entry(null, [hl()]))
      await stored(s, entry(null, [hl(H1, 'green')]))
      expect(api.putAnnotation.mock.calls.map((c) => [c[0], expectedOf(c), (c[1] as AnnotationWrite).color])).toEqual([[H1, null, 'yellow'], [H1, 1, 'green']])
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

    // #1312 review: the page keeps the old id until the next open; every way in reaches the re-keyed row, and edits made
    // under the old id while the re-keyed write was in flight move to the new id.
    async function rekeyInFlight(edit: (s: ReturnType<typeof open>) => void) {
      const s = await opened()
      const retry = deferred<Annotation>()
      api.putAnnotation.mockRejectedValueOnce(conflict('id_conflict', null)).mockReturnValueOnce(retry.promise)
      s.store(entry(null, [hl()]))
      await vi.waitFor(() => expect(api.putAnnotation).toHaveBeenCalledTimes(2))
      edit(s)
      retry.resolve(annotation({ id: MINTED, revision: 1 }))
      await s.flush()
      expect(s.real(H1)).toBe(MINTED)
      // The page's next store, still under the old id: the new row's, nothing to write.
      await stored(s, entry(null, [hl()]))
      return s
    }

    it('idConflict_ANoteMadeUnderTheOldIdWhileTheRetryFlew_WrittenToTheNewRow', async () => {
      const s = await rekeyInFlight((x) => x.setNote(H1, 'a note'))
      expect(api.putAnnotation.mock.calls.slice(2).map((c) => [c[0], expectedOf(c), (c[1] as AnnotationWrite).noteText])).toEqual([[MINTED, 1, 'a note']])
      expect(s.note(MINTED)).toBe('a note')
      expect(last()).toBe('saved')
    })

    // #1312 review: the page's messages under the old id arriving after the re-key landed.
    it('idConflict_ALateNoteAndALateRemovalUnderTheOldId_ReachTheNewRow', async () => {
      const s = await rekeyInFlight(() => {})
      s.setNote(H1, 'late')
      expect(s.note(H1)).toBe('late')
      await s.flush()
      expect(api.putAnnotation.mock.calls.slice(2).map((c) => [c[0], (c[1] as AnnotationWrite).noteText])).toEqual([[MINTED, 'late']])
      s.remove(H1)
      await s.flush()
      expect(api.deleteAnnotation.mock.calls.map((c) => c[0])).toEqual([MINTED])
    })

    it('idConflict_LandingWhileTheSessionCloses_TheLastStoresRecolourWrittenToTheNewId', async () => {
      const s = await opened()
      const retry = deferred<Annotation>()
      api.putAnnotation.mockRejectedValueOnce(conflict('id_conflict', null)).mockReturnValueOnce(retry.promise)
      s.store(entry(null, [hl()]))
      await vi.waitFor(() => expect(api.putAnnotation).toHaveBeenCalledTimes(2))
      // The tab leaves with the page's last store: recoloured, still under the old id.
      const closing = s.close(entry(null, [hl(H1, 'green')]))
      retry.resolve(annotation({ id: MINTED, revision: 1 }))
      await closing
      expect(api.putAnnotation.mock.calls.slice(2).map((c) => [c[0], (c[1] as AnnotationWrite).color])).toEqual([[MINTED, 'green']])
    })

    it('idConflict_ThePageStillOnTheOldId_ItsRecolourReachesTheNewRow', async () => {
      const s = await rekeyInFlight(() => {})
      await stored(s, entry(null, [hl(H1, 'pink')]))
      expect(api.putAnnotation.mock.calls.slice(2).map((c) => [c[0], expectedOf(c), (c[1] as AnnotationWrite).color])).toEqual([[MINTED, 1, 'pink']])
    })

    it('idConflict_ARemovalOfTheOldIdWhileTheRetryFlew_DeletesTheNewRow', async () => {
      await rekeyInFlight((x) => x.remove(H1))
      expect(api.deleteAnnotation.mock.calls.map((c) => c[0])).toEqual([MINTED])
      expect(api.putAnnotation).toHaveBeenCalledTimes(2)
      expect(last()).toBe('saved')
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
      const put = deferred<ReadingState>()
      api.putReadingState.mockReturnValueOnce(put.promise)
      const s = await opened()
      s.store(entry(pos(2)))
      s.store(entry(pos(3)))
      const closed = s.close()
      put.resolve(state(1))
      await closed
      expect(api.putReadingState.mock.calls.map((c) => (c[1] as ReadingStateWrite).currentLocator.value)).toEqual([cfi(2), cfi(3)])
      expect(statuses).toEqual([])
    })

    it('storeWhileClosing_NotWritten', async () => {
      const put = deferred<ReadingState>()
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
      const put = deferred<ReadingState>()
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
        syncStore.reset()
        throw conflict('stale_revision', state(4))
      })
      await stored(s, entry(pos(2)))
      expect(api.putReadingState).toHaveBeenCalledTimes(1)
      expect(statuses).toEqual([])
    })

    it('storeDuringAPass_OneMorePassOnTheLatestEntry', async () => {
      const put = deferred<ReadingState>()
      api.putReadingState.mockReturnValueOnce(put.promise)
      const s = await opened()
      s.store(entry(pos(2)))
      s.store(entry(pos(3)))
      s.store(entry(pos(4)))
      put.resolve(state(1))
      await s.flush()
      expect(api.putReadingState.mock.calls.map((c) => (c[1] as ReadingStateWrite).currentLocator.value)).toEqual([cfi(2), cfi(4)])
      expect(expectedOf(api.putReadingState.mock.calls[1])).toBe(1)
    })
  })

  // #1286: the page's latest `store`, taken by the host synchronously (pagehide, unmount) as a `store` is.
  describe('the last turn', () => {
    it('flushKeepalive_TheLastEntry_KeptAliveOnly_NoOtherPut', async () => {
      api.getReadingState.mockResolvedValue(state(4, 1))
      const s = await opened()
      s.flushKeepalive(entry(pos(3)))
      expect(api.putReadingState).not.toHaveBeenCalled()
      expect(api.keepalivePutState).toHaveBeenCalledTimes(1)
      expect(JSON.parse(api.keepalivePutState.mock.calls[0][1])).toMatchObject({ expectedRevision: 4, currentLocator: { value: cfi(3) } })
    })

    it('close_TheLastEntryWritten', async () => {
      const s = await opened()
      await s.close(entry(pos(3)))
      expect(api.putReadingState.mock.calls.map((c) => (c[1] as ReadingStateWrite).currentLocator.value)).toEqual([cfi(3)])
    })

    it('close_WhileAPassRuns_TheLastEntryOneMorePass_InOrder', async () => {
      const s = await opened()
      const put = deferred<ReadingState>()
      api.putReadingState.mockReturnValueOnce(put.promise)
      s.store(entry(pos(2)))
      const closed = s.close(entry(pos(3)))
      put.resolve(state(1, 2))
      await closed
      expect(api.putReadingState.mock.calls.map((c) => (c[1] as ReadingStateWrite).currentLocator.value)).toEqual([cfi(2), cfi(3)])
      expect(expectedOf(api.putReadingState.mock.calls[1])).toBe(1)
    })

    it('thePostedStoreAfterTheKeepaliveTookIt_NotWrittenAgain', async () => {
      // The page kept (bfcache) after pagehide: its own posted `store` of the same entry arrives. The keepalive
      // answer is never read, so a pass would PUT it again on the old revision (a lost write, maybe our own place offered).
      api.getReadingState.mockResolvedValue(state(4, 1))
      const s = await opened()
      const last = entry(pos(3))
      s.flushKeepalive(last)
      s.store(last)
      await new Promise((r) => setTimeout(r, 0))
      expect(api.keepalivePutState).toHaveBeenCalledTimes(1)
      expect(api.putReadingState).not.toHaveBeenCalled()
      // The next turn is written as usual.
      await stored(s, entry(pos(4)))
      expect(api.putReadingState).toHaveBeenCalledTimes(1)
    })

    it('keepaliveThenTheTabKept_ANextTurnLosesToTheKeepalivesWrite_OursNoOffer_ItsRevisionAdopted', async () => {
      // bfcache: the page survives pagehide and the reader turns on. The keepalive's answer is never read, so the next
      // turn's PUT goes on the old revision and loses to the keepalive's own write: ours, never offered as another
      // device's newer place; the turn is written again on its revision.
      api.getReadingState.mockResolvedValue(state(4, 1))
      const s = await opened()
      // Turns recorded after the restored state (2026-11-01T00:00Z), as a reader's are.
      const later = (min: number) => Date.parse('2026-11-01T00:00:00.000Z') + min * 60_000
      s.flushKeepalive(entry(pos(3, later(1))))
      const kept = JSON.parse(api.keepalivePutState.mock.calls[0][1]) as ReadingStateWrite
      api.putReadingState.mockRejectedValueOnce(conflict('stale_revision', { ...state(5, 3), currentLocator: kept.currentLocator, clientRecordedAt: kept.clientRecordedAt }))
      await stored(s, entry(pos(4, later(2))))
      expect(newer).toEqual([])
      expect(api.putReadingState.mock.calls.map(expectedOf)).toEqual([4, 5])
      expect((api.putReadingState.mock.calls[1][1] as ReadingStateWrite).currentLocator.value).toBe(cfi(4))
    })

    it('keepaliveWhileAPassWriteIsInFlight_ThatWriteLandsItsAnswerLost_ANextTurnLosesToIt_OursNoOffer', async () => {
      // W1 (a pass, P1) in flight; the keepalive W2 (the page's last turn, P2) sent meanwhile. W1 lands and W2 loses,
      // W1's answer never read (the tab frozen in bfcache). The next turn loses to W1's state: ours, never offered.
      api.getReadingState.mockResolvedValue(state(4, 1))
      const s = await opened()
      const later = (min: number) => Date.parse('2026-11-01T00:00:00.000Z') + min * 60_000
      const w1 = deferred<ReadingState>()
      api.putReadingState.mockReturnValueOnce(w1.promise)
      s.store(entry(pos(2, later(1))))
      await vi.waitFor(() => expect(api.putReadingState).toHaveBeenCalledTimes(1))
      const sent = api.putReadingState.mock.calls[0][1] as ReadingStateWrite
      s.flushKeepalive(entry(pos(3, later(2))))
      expect(api.keepalivePutState).toHaveBeenCalledTimes(1)
      w1.reject(offline())
      await new Promise((r) => setTimeout(r, 0))
      api.putReadingState.mockRejectedValueOnce(conflict('stale_revision', { ...state(5, 2), currentLocator: sent.currentLocator, clientRecordedAt: sent.clientRecordedAt }))
      await stored(s, entry(pos(4, later(3))))
      expect(newer).toEqual([])
      expect(api.putReadingState.mock.calls.slice(-2).map(expectedOf)).toEqual([4, 5])
    })

    it('takenAtCloseThenPostedAgain_OneWrite', async () => {
      const s = await opened()
      const last = entry(pos(3))
      const closed = s.close(last)
      s.store(last)
      await closed
      expect(api.putReadingState).toHaveBeenCalledTimes(1)
    })

    it('anotherBooksOrBeforeTheRestore_NotTaken', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const early = open()
      early.flushKeepalive(entry(pos(3)))
      expect(api.keepalivePutState).not.toHaveBeenCalled()
      const s = await opened()
      s.flushKeepalive(entry(pos(3), [], { ...T, sha256: 'cd'.repeat(32) }))
      s.flushKeepalive('not json')
      await s.close(entry(pos(3), [], { ...T, size: 1 }))
      expect(api.keepalivePutState).not.toHaveBeenCalled()
      expect(api.putReadingState).not.toHaveBeenCalled()
      warn.mockRestore()
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

  // #1312: notes (the host's), recolours (the page's form) and removals (a DELETE), against the server's rows.
  describe('notes and removals', () => {
    const body = (n = 0) => api.putAnnotation.mock.calls[n][1] as AnnotationWrite
    async function withServerRow(row: Partial<Annotation> = {}) {
      api.annotations.mockResolvedValue([annotation({ id: H1, revision: 2, ...row })])
      return opened()
    }

    it('setNote_AHighlightTheServerHolds_WrittenOnItsRevisionWithItsForm_NotAgain', async () => {
      const s = await withServerRow()
      s.setNote(H1, 'my note')
      await s.flush()
      expect(api.putAnnotation).toHaveBeenCalledTimes(1)
      expect(body()).toMatchObject({ expectedRevision: 2, noteText: 'my note', color: 'yellow', selectedText: 'Hello' })
      expect(s.note(H1)).toBe('my note')
      expect(last()).toBe('saved')
      // The page's form of it (as drawn from the pull) in a later store: nothing to write.
      await stored(s, entry(pos(2), [drawnLists[0][0]]))
      expect(api.putAnnotation).toHaveBeenCalledTimes(1)
    })

    it('recolour_TheServersNoteKept_APutNeverClearsIt', async () => {
      const s = await withServerRow({ noteText: 'their note' })
      await stored(s, entry(null, [hl(H1, 'green')]))
      expect(body()).toMatchObject({ expectedRevision: 2, color: 'green', noteText: 'their note' })
    })

    it('staleRevision_NoteNotEditedHere_TheRetryKeepsTheirNote', async () => {
      const s = await withServerRow()
      api.putAnnotation.mockRejectedValueOnce(conflict('stale_revision', annotation({ id: H1, revision: 3, noteText: 'written elsewhere' })))
      await stored(s, entry(null, [hl(H1, 'pink')]))
      expect(body(1)).toMatchObject({ expectedRevision: 3, color: 'pink', noteText: 'written elsewhere' })
      expect(s.note(H1)).toBe('written elsewhere')
    })

    it('staleRevision_NoteEditedHere_OursReappliedOnce', async () => {
      const s = await withServerRow()
      api.putAnnotation.mockRejectedValueOnce(conflict('stale_revision', annotation({ id: H1, revision: 3, noteText: 'written elsewhere' })))
      s.setNote(H1, 'mine')
      await s.flush()
      expect(body(1)).toMatchObject({ expectedRevision: 3, noteText: 'mine' })
      expect(s.note(H1)).toBe('mine')
    })

    it('noteEditedWhileItsWriteIsInFlight_TheNewerOneWrittenNext', async () => {
      const s = await withServerRow()
      const put = deferred<Annotation>()
      api.putAnnotation.mockReturnValueOnce(put.promise)
      s.setNote(H1, 'first')
      await Promise.resolve()
      s.setNote(H1, 'second')
      put.resolve(annotation({ id: H1, revision: 3, noteText: 'first' }))
      await s.flush()
      expect(api.putAnnotation.mock.calls.map((c) => [(c[1] as AnnotationWrite).noteText, expectedOf(c)])).toEqual([['first', 2], ['second', 3]])
      expect(s.note(H1)).toBe('second')
    })

    it('noteRefused_NotResentUntilItChanges_Unsaved', async () => {
      const s = await withServerRow()
      api.putAnnotation.mockRejectedValueOnce(fail(422, 'invalid_payload'))
      s.setNote(H1, 'bad')
      await s.flush()
      await s.flush()
      expect(api.putAnnotation).toHaveBeenCalledTimes(1)
      expect(last()).toBe('unsaved')
      s.setNote(H1, 'good')
      await s.flush()
      expect(body(1).noteText).toBe('good')
      expect(last()).toBe('saved')
    })

    it('remove_ADeleteBeforeAnyWriteOfIt_AStoreSentBeforeTheRemovalNeverWritesItAgain', async () => {
      const s = await withServerRow()
      s.remove(H1)
      // The page's store from before the removal (its recolour) arrives after it.
      await stored(s, entry(null, [hl(H1, 'green')]))
      expect(api.deleteAnnotation.mock.calls.map((c) => c[0])).toEqual([H1])
      expect(api.putAnnotation).not.toHaveBeenCalled()
      await stored(s, entry(pos(2), [hl(H1, 'blue')]))
      expect(api.putAnnotation).not.toHaveBeenCalled()
      s.setNote(H1, 'too late')
      expect(s.note(H1)).toBeNull()
      await s.flush()
      expect(api.putAnnotation).not.toHaveBeenCalled()
      expect(last()).toBe('saved')
    })

    it('remove_ThenMadeAgainAtTheSamePlace_TheRemovalPending_TheNewOneIsWritten (#1314 review)', async () => {
      // Its DELETE not sent yet (offline), the reader makes it again: the same CFI and words, a new id. Not the removed
      // one's twin: written, so a tab closed now sends both the DELETE and the PUT.
      const U3 = '33333333-3333-4333-8333-333333333333'
      const s = await withServerRow({ color: 'bookmark' })
      api.deleteAnnotation.mockRejectedValue(offline())
      s.remove(H1)
      await stored(s, entry(null, [hl(U3, 'bookmark')]))
      expect(api.putAnnotation.mock.calls.map((c) => [c[0], (c[1] as AnnotationWrite).color])).toEqual([[U3, 'bookmark']])
      s.flushKeepalive()
      expect(api.keepaliveDeleteAnnotation.mock.calls.map((c) => c[0])).toEqual([H1])
    })

    it('twin_APageIdSkippedAsAHeldRowsTwin_IsThatRowFromNowOn_ItsRemovalTombstonesIt (#1314 review)', async () => {
      // The server holds U2; the page holds the same place and words under its own id U3 (made before U2 reached it).
      const U2 = '22222222-2222-4222-8222-222222222222'
      const U3 = '33333333-3333-4333-8333-333333333333'
      api.annotations.mockResolvedValue([annotation({ id: U2, color: 'bookmark', revision: 4 })])
      const s = await opened()
      await stored(s, entry(null, [hl(U3, 'bookmark')]))
      expect(api.putAnnotation.mock.calls.map((c) => c[0])).not.toContain(U3)
      expect(s.real(U3)).toBe(U2)
      s.remove(U3)
      await s.flush()
      expect(api.deleteAnnotation.mock.calls.map((c) => c[0])).toEqual([U2])
      expect(s.deleted(U3)).toBe(true)
    })

    it('remove_AHighlightTheServerHoldsAsDeleted_NoDeleteSent_DeletedSaid', async () => {
      const s = await withServerRow({ deletedAt: '2026-11-02T00:00:00Z' })
      expect(s.deleted(H1)).toBe(true)
      s.remove(H1)
      await s.flush()
      expect(api.deleteAnnotation).not.toHaveBeenCalled()
    })

    it('remove_ServerNeverHadIt404_Done', async () => {
      const s = await opened()
      api.deleteAnnotation.mockRejectedValueOnce(fail(404, 'not_found'))
      await stored(s, entry(null, [hl(H2)]))
      s.remove(H2)
      await stored(s, entry(null, [hl(H2)]))
      await s.flush()
      expect(api.deleteAnnotation).toHaveBeenCalledTimes(1)
      expect(api.putAnnotation).toHaveBeenCalledTimes(1)
      expect(last()).toBe('saved')
    })

    it('remove_Offline_KeptUnsaved_DeletedOnTheNextFlush', async () => {
      const s = await withServerRow()
      api.deleteAnnotation.mockRejectedValueOnce(offline())
      s.remove(H1)
      await s.flush()
      expect(last()).toBe('unsaved')
      await s.flush()
      expect(api.deleteAnnotation).toHaveBeenCalledTimes(2)
      expect(last()).toBe('saved')
    })

    it('keepalive_ANoteOverTheBudget_Skipped_TheWritesAfterItStillSent', async () => {
      const s = await opened()
      api.putAnnotation.mockRejectedValue(offline())
      api.putReadingState.mockRejectedValue(offline())
      const H2_AT = { ...hl(H2), cfi: 'epubcfi(/6/6!/4/2,/1:0,/1:5)' }
      await stored(s, entry(pos(2), [hl(H1), H2_AT]))
      s.setNote(H1, 'x'.repeat(KEEPALIVE_BUDGET + 1))
      await s.flush()
      s.flushKeepalive()
      expect(api.keepalivePutState).toHaveBeenCalledTimes(1)
      expect(api.keepalivePutAnnotation.mock.calls.map((c) => c[0])).toEqual([H2])
    })

    it('keepalive_ARemovalAndANoteStillPending_SentBeforeTheTabGoes', async () => {
      const s = await withServerRow()
      api.deleteAnnotation.mockRejectedValue(offline())
      api.putAnnotation.mockRejectedValue(offline())
      // H1 recoloured in the page's last store, then removed; H2 at another place (the same CFI and text would be H1's twin).
      await stored(s, entry(null, [hl(H1, 'green'), { ...hl(H2), cfi: 'epubcfi(/6/6!/4/2,/1:0,/1:5)' }]))
      s.remove(H1)
      s.setNote(H2, 'kept')
      await s.flush()
      s.flushKeepalive()
      // The removal is sent, never the removed one's form.
      expect(api.keepaliveDeleteAnnotation.mock.calls.map((c) => c[0])).toEqual([H1])
      expect(api.keepalivePutAnnotation.mock.calls.map((c) => [c[0], JSON.parse(c[1]).noteText])).toEqual([[H2, 'kept']])
    })

    it('setNote_BeforeTheHighlightsLoaded_WrittenOnceTheyLand', async () => {
      const pull = deferred<Annotation[]>()
      api.annotations.mockReturnValue(pull.promise)
      const s = open()
      await s.restore()
      const loading = s.loadHighlights()
      s.setNote(H1, 'early')
      await Promise.resolve()
      expect(api.putAnnotation).not.toHaveBeenCalled()
      pull.resolve([annotation({ id: H1, revision: 5 })])
      await loading
      await s.flush()
      expect(body()).toMatchObject({ expectedRevision: 5, noteText: 'early' })
    })
  })
})
