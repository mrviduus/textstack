/**
 * The V2 paths end to end over a fake API (#1025 M2.7, from QA's probes): the one switch per API
 * with the flag off and on, the probe's retry rules, the reading-state write outcomes, and the
 * upload's error paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { initApi, ApiError } from '@textstack/shared'
import { resetV2ForTests, startV2Probe, reprobeV2AfterReconnect, saveV2Progress, uploadV2Book, pullV2Books, getV2UserBook, V2UploadError, type UploadIo } from './v2'
import { userBooksApi } from './userBooksApi'
import { vocabularyApi } from './vocabularyApi'
import { userBookHighlightsApi } from './v2Highlights'
import { flushPendingSessions, enqueuePendingSession, clearPendingSessions } from './pendingSessions'
import { setUserBookV2State, getUserBookV2State } from './progressStorage'

vi.mock('./offlineDb', () => ({ dropReplacedUserBookFiles: async () => [] }))
vi.mock('./originalFileCache', () => ({ deleteOriginal: async () => {} }))

type Answer = { status: number; body?: unknown }
interface Call { method: string; path: string; body: unknown }

/** `METHOD /path` (after http://api, no query) → answers in turn, last repeating; a function answers per call. */
function fakeApi(routes: Record<string, Answer[] | ((c: Call) => Answer)>, fallback: Answer = { status: 200, body: {} }) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('http://api', '').split('?')[0]
    const method = init.method ?? 'GET'
    const call = { method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body }
    calls.push(call)
    const r = routes[`${method} ${path}`]
    const a = typeof r === 'function' ? r(call) : r ? (r.length > 1 ? r.shift()! : r[0]) : fallback
    if (a.status === 0) throw new TypeError('Network request failed')
    return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) }
  }))
  return calls
}

beforeEach(async () => {
  resetV2ForTests()
  initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null })
  await clearPendingSessions()
})
afterEach(() => vi.unstubAllGlobals())

const session = { userBookId: 'b1', startedAt: '2026-11-01T00:00:00Z', endedAt: '2026-11-01T00:10:00Z', durationSeconds: 600, wordsRead: 100, startPercent: 0, endPercent: 0.1 }

/** Every switched call once; failures (a fake `{}` body a mapper cannot read) are fine — only the routes matter. */
async function everySwitchedCall() {
  const swallow = (p: Promise<unknown>) => p.catch(() => {})
  await swallow(userBooksApi.getUserBooks())
  await swallow(userBooksApi.getUserBook('b1'))
  await swallow(userBooksApi.getUserBookChapter('b1', 'k1'))
  await swallow(userBooksApi.getUserBookProgress('b1'))
  await swallow(userBooksApi.updateUserBookProgress('b1', { chapterSlug: 'k1', percent: 0.1 } as never))
  await swallow(userBooksApi.markUserBookComplete('b1'))
  await swallow(userBooksApi.unmarkUserBookComplete('b1'))
  await swallow(userBooksApi.getUserBookBookmarks('b1'))
  await swallow(userBooksApi.deleteUserBook('b1'))
  await swallow(vocabularyApi.saveWord({ word: 'quay', language: 'en', sentence: 'At the quay.', userBookId: 'b1', id: 'w1', operationId: 'o1' } as never))
  await swallow(vocabularyApi.getWords())
  await swallow(vocabularyApi.getReaderVocab())
  await swallow(vocabularyApi.updateWord('w1', { translation: 'x' }))
  await swallow(vocabularyApi.deleteWord('w1'))
  await swallow(vocabularyApi.getReviewQueue(10, false))
  await swallow(vocabularyApi.submitReview({ wordId: 'w1', isCorrect: true, responseTimeMs: 900 }))
  await swallow(userBookHighlightsApi.getUserBookHighlights('b1'))
  await swallow(userBookHighlightsApi.createHighlight({ userBookId: 'b1', anchorJson: '{"exact":"x"}', color: 'yellow', selectedText: 'x' }))
  await swallow(userBookHighlightsApi.deleteHighlight('h1'))
  await enqueuePendingSession(session)
  await swallow(flushPendingSessions())
}

describe('the switch', () => {
  it('everySwitchedCall_StatusUnmapped404_NeverTouchesV2BeyondOneProbe', async () => {
    const calls = fakeApi({ 'GET /me/v2/status': [{ status: 404 }] }, { status: 200, body: [] })
    await everySwitchedCall()
    expect(calls.filter((c) => c.path === '/me/v2/status')).toHaveLength(1)
    expect(calls.filter((c) => c.path.startsWith('/me/v2/') && c.path !== '/me/v2/status').map((c) => `${c.method} ${c.path}`)).toEqual([])
    expect(calls.length).toBeGreaterThan(15)
    expect(userBooksApi.getUserBookFileUrl('b1', 'http://api')).not.toContain('/me/v2/')
  })

  it('everySwitchedCall_StatusOn_ReachesV2ForEachApi', async () => {
    const calls = fakeApi({ 'GET /me/v2/status': [{ status: 200, body: { maxPartBytes: 1024 } }] }, { status: 200, body: { items: [], hasMore: false, cursor: null } })
    await everySwitchedCall()
    const v2 = calls.map((c) => `${c.method} ${c.path}`).filter((p) => p.includes('/me/v2/') && !p.endsWith('/status'))
    for (const route of ['/me/v2/library/changes', '/me/v2/vocabulary/', '/me/v2/annotations']) {
      expect(v2.some((p) => p.includes(route)), route).toBe(true)
    }
  })

  it('getUserBookFileUrl_V2OnFileUnknown_EmptyNeverLegacyRoute', async () => {
    fakeApi({ 'GET /me/v2/status': [{ status: 200, body: { maxPartBytes: 5 } }] })
    await startV2Probe()
    expect(userBooksApi.getUserBookFileUrl('b-unknown', 'http://api')).toBe('')
  })

  it('probe_401ThenSession_AsksAgain', async () => {
    fakeApi({ 'GET /me/v2/status': [{ status: 401 }, { status: 200, body: { maxPartBytes: 5 } }] })
    expect((await startV2Probe()).enabled).toBe(false)
    expect((await startV2Probe()).enabled).toBe(true)
  })

  it('probe_OfflineAtStartThenReconnect_AsksAgainAndTurnsOn', async () => {
    fakeApi({ 'GET /me/v2/status': [{ status: 0 }, { status: 200, body: { maxPartBytes: 5 } }] })
    expect((await startV2Probe()).enabled).toBe(false)
    expect((await startV2Probe()).enabled).toBe(false) // not per call: only a reconnect asks again
    expect((await reprobeV2AfterReconnect()).enabled).toBe(true)
  })

  it('probe_503AtStartThenReconnect_AsksAgainAndTurnsOn', async () => {
    fakeApi({ 'GET /me/v2/status': [{ status: 503, body: { code: 'v2_unavailable', message: 'x' } }, { status: 200, body: { maxPartBytes: 5 } }] })
    expect((await startV2Probe()).enabled).toBe(false)
    expect((await reprobeV2AfterReconnect()).enabled).toBe(true)
  })

  it('probe_404ThenReconnect_StaysOffWithoutAsking', async () => {
    const calls = fakeApi({ 'GET /me/v2/status': [{ status: 404 }, { status: 200, body: { maxPartBytes: 5 } }] })
    expect((await startV2Probe()).enabled).toBe(false)
    expect((await reprobeV2AfterReconnect()).enabled).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe('vocabulary on V2', () => {
  const word = { id: 'w1', word: 'quay', language: 'en', translation: null, definition: null, stage: 0, intervalDays: 0, consecutiveCorrect: 0,
    nextReviewAt: '2026-11-01T00:00:00Z', lastReviewedAt: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', revision: 1, examples: [] }

  it('reviewQueueAndSubmit_V2On_FlashcardsAndPostsCorrectnessAndTime', async () => {
    const calls = fakeApi({
      'GET /me/v2/status': [{ status: 200, body: { maxPartBytes: 5 } }],
      'GET /me/v2/vocabulary/due': [{ status: 200, body: [word] }],
      'POST /me/v2/vocabulary/reviews': [{ status: 200, body: { review: { stageBefore: 0, stageAfter: 0 }, word } }],
    })
    const queue = await vocabularyApi.getReviewQueue(10, false)
    expect(queue.cards.map((c) => c.reviewMode)).toEqual(['flashcard'])
    await vocabularyApi.submitReview({ wordId: 'w1', isCorrect: false, responseTimeMs: 1234.6 })
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ wordId: 'w1', isCorrect: false, responseTimeMs: 1235 })
  })
})

describe('reading-state write outcomes', () => {
  const on = { 'GET /me/v2/status': [{ status: 200, body: { maxPartBytes: 5 } }] }
  const state = (revision: number) => ({
    bookId: 'b1', fileId: 'f1', revision, bookFraction: 0.2, completedAt: null, frontierLocator: null, frontierFraction: null,
    currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 3 } }, clientRecordedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', resetRevision: null,
  })

  it('saveV2Progress_Reset_WritesAgainOnTheNewRevision', async () => {
    await setUserBookV2State('b1', { revision: 2, fileId: 'f1' })
    const calls = fakeApi({ ...on, 'PUT /me/v2/books/b1/reading-state': [
      { status: 409, body: { code: 'reset', message: 'x', current: state(9) } },
      { status: 200, body: state(10) },
    ] })
    expect(await saveV2Progress('b1', { chapterSlug: null, locator: 'page:4', percent: 0.3 })).toBe('accepted')
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts.map((p) => (p.body as { expectedRevision: number }).expectedRevision)).toEqual([2, 9])
    expect(await getUserBookV2State('b1')).toMatchObject({ revision: 10, fileId: 'f1' })
  })

  it('saveV2Progress_UnknownFileTwice_RetriesOnceThenDropped', async () => {
    await setUserBookV2State('b1', { revision: 2, fileId: 'f-old' })
    const calls = fakeApi({ ...on,
      'PUT /me/v2/books/b1/reading-state': [{ status: 409, body: { code: 'unknown_file', message: 'x' } }],
      'GET /me/v2/library/changes': [{ status: 200, body: { items: [{ id: 'b1', currentFile: { id: 'f-new' } }], hasMore: false, cursor: null } }],
    })
    expect(await saveV2Progress('b1', { chapterSlug: null, locator: 'page:4' })).toBe('dropped')
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts.map((p) => (p.body as { fileId: string }).fileId)).toEqual(['f-old', 'f-new'])
  })

  it('saveV2Progress_StaleWithoutCurrent_DroppedAndRevisionForgotten', async () => {
    await setUserBookV2State('b1', { revision: 2, fileId: 'f1' })
    fakeApi({ ...on, 'PUT /me/v2/books/b1/reading-state': [{ status: 409, body: { code: 'stale_revision', message: 'x', current: null } }] })
    expect(await saveV2Progress('b1', { chapterSlug: null, locator: 'page:4' })).toBe('dropped')
    expect(await getUserBookV2State('b1')).toBeNull()
  })

  it('saveV2Progress_FutureStampAndOverrangeFraction_ClampedToNowAndOne', async () => {
    await setUserBookV2State('b1', { revision: 2, fileId: 'f1' })
    const calls = fakeApi({ ...on, 'PUT /me/v2/books/b1/reading-state': [{ status: 200, body: state(3) }] })
    const before = Date.now()
    await saveV2Progress('b1', { chapterSlug: null, locator: 'page:4', percent: 1.7, updatedAt: new Date(before + 3_600_000).toISOString() })
    const body = calls.find((c) => c.method === 'PUT')!.body as { clientRecordedAt: string; bookFraction: number }
    expect(Date.parse(body.clientRecordedAt)).toBeLessThanOrEqual(Date.now())
    expect(body.bookFraction).toBe(1)
  })

  it('saveV2Progress_ReflowPlace_SendsTextstackPositionNeverCfi', async () => {
    await setUserBookV2State('b1', { revision: 2, fileId: 'f1' })
    const calls = fakeApi({ ...on, 'PUT /me/v2/books/b1/reading-state': [{ status: 200, body: state(3) }] })
    await saveV2Progress('b1', { chapterSlug: 'key-7', locator: 'scroll:0.5', percent: 0.4 })
    const loc = (calls.find((c) => c.method === 'PUT')!.body as { currentLocator: { scheme: string; value: { chapterSlug?: string } } }).currentLocator
    expect(loc.scheme).toBe('textstack-position-v1')
    expect(loc.value.chapterSlug).toBe('key-7')
  })

  it('saveV2Progress_StoredStateOnSupersededFile_FirstWriteOnCurrentFile', async () => {
    await setUserBookV2State('b1', { revision: 5, fileId: 'f-old' })
    const calls = fakeApi({ ...on,
      'GET /me/v2/library/changes': [{ status: 200, body: { items: [{ id: 'b1', currentFile: { id: 'f-new' } }], hasMore: false, cursor: null } }],
      'PUT /me/v2/books/b1/reading-state': [{ status: 200, body: { ...state(1), fileId: 'f-new' } }],
    })
    await pullV2Books()
    expect(await saveV2Progress('b1', { chapterSlug: null, locator: 'page:4' })).toBe('accepted')
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ expectedRevision: null, fileId: 'f-new' })
  })

  it('getV2UserBook_StateCompleted_BookPageShowsCompleted', async () => {
    fakeApi({ ...on,
      'GET /me/v2/library/changes': [{ status: 200, body: { items: [{ id: 'b1', title: 't', currentFile: { id: 'f1', format: 'epub', hasContent: true } }], hasMore: false, cursor: null } }],
      'GET /me/v2/books/b1/files/f1/chapters': [{ status: 200, body: { items: [], ingestion: 'succeeded' } }],
      'GET /me/v2/books/b1/reading-state': [{ status: 200, body: { ...state(2), completedAt: '2026-11-02T00:00:00Z' } }],
    })
    expect((await getV2UserBook('b1')).completedAt).toBe('2026-11-02T00:00:00Z')
  })

  it('saveV2Progress_ServerError_Throws', async () => {
    await setUserBookV2State('b1', { revision: 2, fileId: 'f1' })
    fakeApi({ ...on, 'PUT /me/v2/books/b1/reading-state': [{ status: 500, body: { message: 'boom' } }] })
    await expect(saveV2Progress('b1', { chapterSlug: null, locator: 'page:4' })).rejects.toBeInstanceOf(ApiError)
  })
})

describe('upload error paths', () => {
  const bytes = Uint8Array.from({ length: 25 }, (_, i) => i)
  const sha = createHash('sha256').update(bytes).digest('hex')
  const io = (src: () => Uint8Array = () => bytes, sent: number[] = []): UploadIo => ({
    open: () => ({ size: bytes.length, read: (at, n) => src().slice(at, at + n), close: () => {} }),
    sendPart: async (bookId, fileId, index, part) => {
      sent.push(index)
      const r = await fetch(`http://api/me/v2/books/${bookId}/files/${fileId}/parts/${index}`, { method: 'PUT', body: part as BodyInit })
      if (!r.ok) throw Object.assign(new ApiError(r.status, 'x'), { body: JSON.parse(await r.text()) })
      return {}
    },
    yieldNow: async () => {},
  })
  const importAnswer = (c: Call): Answer => ({ status: 201, body: { id: c.path.split('/')[4], currentFile: { id: (c.body as { file: { id: string } }).file.id, hasContent: false } } })

  it('uploadV2Book_DuplicateFileOnImport_SendsToTheExistingBook', async () => {
    const calls = fakeApi({
      [`GET /me/v2/books/by-sha256/${sha}`]: [{ status: 404 }],
      'POST /me/v2/books/b-dup/files/f-dup/content': [{ status: 200, body: {} }],
      'PUT /me/v2/books/b-dup/files/f-dup/parts/0': [{ status: 200, body: {} }],
    }, { status: 409, body: { code: 'duplicate_file', message: 'x', current: { id: 'b-dup', currentFile: { id: 'f-dup', hasContent: false } } } })
    expect(await uploadV2Book({ uri: 'u', name: 'a.epub' }, 25, io())).toEqual({ bookId: 'b-dup', existing: false })
    expect(calls.some((c) => c.path === '/me/v2/books/b-dup/files/f-dup/parts/0')).toBe(true)
  })

  it('uploadV2Book_ContentMismatchSameBytes_ResendsOnce', async () => {
    const sent: number[] = []
    fakeApi({ [`GET /me/v2/books/by-sha256/${sha}`]: [{ status: 404 }] }, { status: 200, body: {} })
    const fetchImpl = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    let completes = 0
    fetchImpl.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const path = url.replace('http://api', '')
      const method = init.method ?? 'GET'
      let a: Answer = { status: 200, body: {} }
      if (path.startsWith('/me/v2/books/by-sha256/')) a = { status: 404 }
      else if (method === 'PUT' && /^\/me\/v2\/books\/[^/]+$/.test(path)) a = importAnswer({ method, path, body: JSON.parse(init.body as string) })
      else if (path.endsWith('/content')) a = ++completes === 1 ? { status: 422, body: { code: 'content_mismatch', message: 'x' } } : { status: 200, body: {} }
      return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) }
    })
    await uploadV2Book({ uri: 'u', name: 'a.epub' }, 25, io(undefined, sent))
    expect(sent).toEqual([0, 0])
    expect(completes).toBe(2)
  })

  it('uploadV2Book_ContentMismatchFileChanged_TellsTheReader', async () => {
    let reads = 0
    const changing = () => (reads++ < 2 ? bytes : bytes.map((b) => b ^ 1))
    fakeApi({ [`GET /me/v2/books/by-sha256/${sha}`]: [{ status: 404 }] }, { status: 200, body: {} })
    const fetchImpl = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchImpl.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const path = url.replace('http://api', '')
      const method = init.method ?? 'GET'
      let a: Answer = { status: 200, body: {} }
      if (path.startsWith('/me/v2/books/by-sha256/')) a = { status: 404 }
      else if (method === 'PUT' && /^\/me\/v2\/books\/[^/]+$/.test(path)) a = importAnswer({ method, path, body: JSON.parse(init.body as string) })
      else if (path.endsWith('/content')) a = { status: 422, body: { code: 'content_mismatch', message: 'x' } }
      return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) }
    })
    const sent: number[] = []
    const err = await uploadV2Book({ uri: 'u', name: 'a.epub' }, 25, io(changing, sent)).catch((e) => e)
    expect(sent).toEqual([0]) // changed bytes are never re-sent
    expect(err).toBeInstanceOf(V2UploadError)
    expect((err as V2UploadError).code).toBe('content_mismatch')
  })

  it('uploadV2Book_IncompleteTwice_GivesUpAfterOneResend', async () => {
    const sent: number[] = []
    fakeApi({}, { status: 200, body: {} })
    const fetchImpl = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchImpl.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const path = url.replace('http://api', '')
      const method = init.method ?? 'GET'
      let a: Answer = { status: 200, body: {} }
      if (path.startsWith('/me/v2/books/by-sha256/')) a = { status: 404 }
      else if (method === 'PUT' && /^\/me\/v2\/books\/[^/]+$/.test(path)) a = importAnswer({ method, path, body: JSON.parse(init.body as string) })
      else if (path.endsWith('/content')) a = { status: 400, body: { code: 'incomplete_upload', message: 'x' } }
      return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) }
    })
    await expect(uploadV2Book({ uri: 'u', name: 'a.epub' }, 25, io(undefined, sent))).rejects.toBeInstanceOf(ApiError)
    expect(sent).toEqual([0, 0])
  })

  it('uploadV2Book_QuotaOnAPart_NamesTheQuota', async () => {
    fakeApi({}, { status: 200, body: {} })
    const fetchImpl = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchImpl.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const path = url.replace('http://api', '')
      const method = init.method ?? 'GET'
      let a: Answer = { status: 200, body: {} }
      if (path.startsWith('/me/v2/books/by-sha256/')) a = { status: 404 }
      else if (method === 'PUT' && /^\/me\/v2\/books\/[^/]+$/.test(path)) a = importAnswer({ method, path, body: JSON.parse(init.body as string) })
      else if (path.includes('/parts/')) a = { status: 409, body: { code: 'quota_exceeded', message: 'x', current: { used: 10 * 1048576, limit: 20 * 1048576 } } }
      return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) }
    })
    const err = await uploadV2Book({ uri: 'u', name: 'a.epub' }, 25, io()).catch((e) => e)
    expect(err).toBeInstanceOf(V2UploadError)
    expect((err as Error).message).toContain('10 MB of 20 MB')
  })

  it('uploadV2Book_CancelWhileFillingAnotherDevicesBook_NeverRemovesIt', async () => {
    const calls = fakeApi({ [`GET /me/v2/books/by-sha256/${sha}`]: [{ status: 200, body: { id: 'b-other', currentFile: { id: 'f-other', hasContent: false } } }] })
    const cancelling: UploadIo = { ...io(), sendPart: async () => { throw Object.assign(new Error('Upload cancelled'), { aborted: true }) } }
    await expect(uploadV2Book({ uri: 'u', name: 'a.epub' }, 25, cancelling)).rejects.toMatchObject({ aborted: true })
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([])
  })

  it('uploadV2Book_DuplicateFileWithoutCurrent_LooksTheBookUpAgain', async () => {
    fakeApi({
      [`GET /me/v2/books/by-sha256/${sha}`]: [{ status: 404 }, { status: 200, body: { id: 'b-dup', currentFile: { id: 'f-dup', hasContent: true } } }],
    }, { status: 409, body: { code: 'duplicate_file', message: 'x' } })
    expect(await uploadV2Book({ uri: 'u', name: 'a.epub' }, 25, io())).toEqual({ bookId: 'b-dup', existing: true })
  })
})
