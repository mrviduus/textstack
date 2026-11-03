import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startV2Probe, v2Status, resetV2ForTests, uploadV2Book, V2UploadError, saveV2Progress, readV2Progress,
  v2Locator, chapterAtFraction, pullV2Books,
} from '../v2'

const API = 'http://localhost:8080/me/v2'

type Answer = { status: number; body?: unknown }
interface Call { method: string; path: string; body: unknown }

/** A fake API: each `METHOD /path` (under /me/v2, no query) answers its list in turn, the last repeating. */
function fakeApi(routes: Record<string, Answer[]>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const path = url.replace(API, '').split('?')[0]
    calls.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    const queue = routes[`${method} ${path}`]
    if (!queue) throw new Error(`unexpected ${method} ${path}`)
    const a = queue.length > 1 ? queue.shift()! : queue[0]
    return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) }
  }))
  return calls
}

const file = (id: string, extra: object = {}) => ({ id, sha256: 'x', byteSize: 3, originalName: 'b.epub', format: 'epub', hasContent: true, ...extra })
const book = (id: string, fileId: string) => ({ id, title: 'T', tags: [], updatedAt: '2026-11-02T00:00:00Z', removedAt: null, currentFile: file(fileId) })
const feed = (...items: unknown[]) => [{ status: 200, body: { items, cursor: null, hasMore: false } }]
const conflict = (code: string, extra: object = {}) => ({ status: 409, body: { code, message: code, ...extra } })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetV2ForTests()
})

describe('the V2 probe', () => {
  it('is off until a session starts it', async () => {
    const calls = fakeApi({})
    expect(await v2Status()).toEqual({ enabled: false, maxPartBytes: 0 })
    expect(calls).toHaveLength(0)
  })

  it('turns V2 on with the server part size on 200, once per app start', async () => {
    const calls = fakeApi({ 'GET /status': [{ status: 200, body: { maxPartBytes: 4096 } }] })
    await startV2Probe()
    await startV2Probe()
    expect(await v2Status()).toEqual({ enabled: true, maxPartBytes: 4096 })
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['a 404 (flag off)', { status: 404 }],
    ['a 503 (V2 unavailable)', { status: 503, body: { code: 'v2_unavailable', message: 'paused' } }],
  ])('stays off for the app start on %s', async (_name, answer) => {
    fakeApi({ 'GET /status': [answer] })
    expect((await startV2Probe()).enabled).toBe(false)
  })

  it('stays off when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect((await startV2Probe()).enabled).toBe(false)
  })
})

// sha256 of the bytes 1..5, the fixture file below.
const B = '00000000-0000-4000-8000-00000000b001'
const F = '00000000-0000-4000-8000-00000000f001'
const SHA = '74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0'

describe('the V2 upload', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-00000000b001')
      .mockReturnValueOnce('00000000-0000-4000-8000-00000000f001')
  })

  const epub = () => new File([new Uint8Array([1, 2, 3, 4, 5])], 'My Book.epub')
  const parts = () => {
    const sent: { url: string; size: number }[] = []
    return { sent, send: async (url: string, part: Blob) => { sent.push({ url, size: part.size }) } }
  }

  it('hashes, imports the metadata, sends the parts by the server size and completes', async () => {
    const calls = fakeApi({
      [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
      [`PUT /books/${B}`]: [{ status: 201, body: book(B, F) }],
      [`POST /books/${B}/files/${F}/content`]: [{ status: 200, body: file(F) }],
    })
    const { sent, send } = parts()

    const result = await uploadV2Book(epub(), 2, send)

    expect(result).toMatchObject({ userBookId: B, status: 'Processing', hasOriginalPdf: false })
    expect(calls[1].body).toEqual({
      title: 'My Book',
      file: { id: F, sha256: SHA, byteSize: 5, originalName: 'My Book.epub', format: 'epub' },
    })
    expect(sent.map((p) => [p.url.split('/parts/')[1], p.size])).toEqual([['0', 2], ['1', 2], ['2', 1]])
    expect(calls[2].body).toEqual({ partCount: 3 })
  })

  it('opens the book that already has these bytes instead of importing', async () => {
    fakeApi({ [`GET /books/by-sha256/${SHA}`]: [{ status: 200, body: book('old', 'f-old') }] })
    expect(await uploadV2Book(epub(), 2, parts().send)).toMatchObject({ userBookId: 'old', existing: true })
  })

  it('opens the existing book on duplicate_file', async () => {
    fakeApi({
      [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
      [`PUT /books/${B}`]: [conflict('duplicate_file', { current: book('twin', 'f-twin') })],
    })
    expect(await uploadV2Book(epub(), 2, parts().send)).toMatchObject({ userBookId: 'twin', existing: true })
  })

  it('re-sends every part once on incomplete_upload, then completes', async () => {
    fakeApi({
      [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
      [`PUT /books/${B}`]: [{ status: 201, body: book(B, F) }],
      [`POST /books/${B}/files/${F}/content`]: [{ status: 400, body: { code: 'incomplete_upload', message: 'x' } }, { status: 200, body: file(F) }],
    })
    const { sent, send } = parts()
    await uploadV2Book(epub(), 5, send)
    expect(sent).toHaveLength(2)
  })

  it('re-hashes on content_mismatch, sends once more, and tells the reader if it fails again', async () => {
    fakeApi({
      [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
      [`PUT /books/${B}`]: [{ status: 201, body: book(B, F) }],
      [`POST /books/${B}/files/${F}/content`]: [{ status: 422, body: { code: 'content_mismatch', message: 'x' } }],
    })
    const { sent, send } = parts()
    const error = await uploadV2Book(epub(), 5, send).catch((e) => e)
    expect(error).toBeInstanceOf(V2UploadError)
    expect(error.code).toBe('content_mismatch')
    expect(sent).toHaveLength(2)
  })

  it('carries used and limit on quota_exceeded', async () => {
    fakeApi({
      [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }],
      [`PUT /books/${B}`]: [{ status: 201, body: book(B, F) }],
      [`POST /books/${B}/files/${F}/content`]: [{ status: 413, body: { code: 'quota_exceeded', message: 'x', current: { used: 9, limit: 10 } } }],
    })
    const error = await uploadV2Book(epub(), 5, parts().send).catch((e) => e)
    expect(error).toMatchObject({ code: 'quota_exceeded', quota: { used: 9, limit: 10 } })
  })
})

describe('the V2 reading state', () => {
  const position = { v: 1, chapterSlug: 'two', anchor: { prefix: 'a', exact: 'quote', suffix: 'b', startOffset: 3, endOffset: 8 }, charOffset: 3, chapterFraction: 0.4 }
  const write = { chapterSlug: 'two', percent: 0.5, updatedAt: '2026-11-02T00:00:00.000Z', positionJson: JSON.stringify(position) }
  const state = (bookId: string, revision: number, value: unknown = position) => ({
    bookId, fileId: 'f1', currentLocator: { version: 1, scheme: 'textstack-position-v1', value }, bookFraction: 0.7,
    frontierLocator: null, frontierFraction: null, completedAt: null, clientRecordedAt: '2026-11-02T00:00:00Z',
    updatedAt: '2026-11-02T00:00:01Z', revision, resetRevision: null,
  })

  it("writes the reader's TextPosition as textstack-position-v1, never a CFI, and a PDF page as pdf-page", () => {
    expect(v2Locator(write)).toEqual({ version: 1, scheme: 'textstack-position-v1', value: position })
    expect(v2Locator({ chapterSlug: null, locator: 'page:12' })).toEqual({ version: 1, scheme: 'pdf-page', value: { page: 12 } })
    expect(v2Locator({ chapterSlug: 'two' })).toEqual({ version: 1, scheme: 'textstack-position-v1', value: { v: 1, chapterSlug: 'two', chapterFraction: 0 } })
  })

  it('makes the first write with a null revision on the current file, and the next on the revision it got', async () => {
    const calls = fakeApi({
      'GET /library/changes': feed(book('rb1', 'f1')),
      'PUT /books/rb1/reading-state': [{ status: 200, body: state('rb1', 1) }, { status: 200, body: state('rb1', 2) }],
    })
    await saveV2Progress('rb1', write)
    await saveV2Progress('rb1', write)
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts[0].body).toMatchObject({ expectedRevision: null, fileId: 'f1', bookFraction: 0.5, currentLocator: { scheme: 'textstack-position-v1' } })
    expect(puts[1].body).toMatchObject({ expectedRevision: 1 })
  })

  it("adopts the server's place on stale_revision and writes on its revision next", async () => {
    const theirs = { ...position, chapterSlug: 'three' }
    const calls = fakeApi({
      'GET /library/changes': feed(book('rb2', 'f1')),
      'PUT /books/rb2/reading-state': [conflict('stale_revision', { revision: 5, current: state('rb2', 5, theirs) }), { status: 200, body: state('rb2', 6) }],
    })
    const outcome = await saveV2Progress('rb2', write)
    expect(outcome.adopted).toMatchObject({ chapterSlug: 'three', percent: 0.7, positionJson: JSON.stringify(theirs) })
    await saveV2Progress('rb2', write)
    expect(calls.filter((c) => c.method === 'PUT')[1].body).toMatchObject({ expectedRevision: 5 })
  })

  it('asks for a reload on file_replaced and drops the write on chapter_not_found', async () => {
    fakeApi({
      'GET /library/changes': feed(book('rb3', 'f1'), book('rb4', 'f1')),
      'PUT /books/rb3/reading-state': [conflict('file_replaced', { fileId: 'f2' })],
      'PUT /books/rb4/reading-state': [conflict('chapter_not_found')],
    })
    expect(await saveV2Progress('rb3', write)).toEqual({ reload: true })
    expect(await saveV2Progress('rb4', write)).toEqual({})
  })

  it('restores a V2 reader epub-cfi from its fraction, by word counts, never as a chapter place', async () => {
    fakeApi({
      'GET /books/rb5/reading-state': [{ status: 200, body: { ...state('rb5', 1), currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)', quote: 'q' } } }],
      'GET /library/changes': feed(book('rb5', 'f5')),
      'GET /books/rb5/files/f5/chapters': [{ status: 200, body: { items: [{ chapterKey: 'one', wordCount: 100 }, { chapterKey: 'two', wordCount: 100 }], ingestion: 'succeeded' } }],
    })
    await pullV2Books()
    expect(await readV2Progress('rb5')).toMatchObject({ chapterSlug: 'two', positionJson: null, percent: 0.7 })
  })

  it('picks the chapter at a fraction by cumulative word counts', () => {
    const items = [{ chapterKey: 'a', wordCount: 10 }, { chapterKey: 'b', wordCount: 30 }, { chapterKey: 'c', wordCount: null }]
    expect(chapterAtFraction(items, 0)).toBe('a')
    expect(chapterAtFraction(items, 0.5)).toBe('b')
    expect(chapterAtFraction(items, 1)).toBe('c')
    expect(chapterAtFraction([], 0.5)).toBeNull()
  })
})
