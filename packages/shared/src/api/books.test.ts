import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initApi } from './client'
import { forgetPulls, type Book, type FileChapters } from './sync'
import { createBooks, type BooksPlatform } from './books'
import { fakeApi, feed, book, conflict, state, resetMidCall } from './__tests__/fakeSyncApi'

const API = 'http://api'

// The optional hooks only mobile passes: web never runs these branches.
describe('the shared V2 book client', () => {
  let epoch = 0
  const reset = () => {
    epoch++
    forgetPulls()
  }
  const client = (extra: Partial<BooksPlatform> = {}) => createBooks({
    books: new Map<string, Book>(),
    chapters: new Map<string, FileChapters>(),
    epoch: () => epoch,
    keepState: () => {},
    forgetState: () => {},
    progressBody: async () => ({ expectedRevision: 1, fileId: 'f1', currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 2 } }, bookFraction: 0.1, clientRecordedAt: '2026-11-02T00:00:00Z' }),
    ...extra,
  })

  beforeEach(() => {
    forgetPulls()
    initApi({ baseUrl: API, getAccessToken: async () => 't', onUnauthorized: async () => null })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('pullV2Books_FlightReplacedOnReset_NextPullIsItsOwn', async () => {
    const single = () => {
      let current: Promise<Book[]> | null = null
      return { run: (pull: () => Promise<Book[]>) => (current ??= pull().finally(() => { current = null })) }
    }
    let flight = single()
    const answers: Array<() => void> = []
    const fetchSpy = vi.fn(() => new Promise((resolve) => {
      answers.push(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ items: [], cursor: null, hasMore: false }) }))
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const c = client({ pullFlight: (pull) => flight.run(pull) })

    const first = c.pullBooks()
    reset()
    flight = single() // as mobile's v2Store.reset: the hook is read per pull, never captured
    const second = c.pullBooks()
    await new Promise((r) => setTimeout(r, 0))
    for (const a of answers) a()
    await Promise.all([first, second])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('pullV2Books_KeptPull_RunsAfterPullWithItsBooks', async () => {
    fakeApi({ 'GET /me/v2/library/changes': feed(book('b1', 'f1')) }, API)
    const afterPull = vi.fn(async () => {})
    await client({ afterPull }).pullBooks()
    expect(afterPull).toHaveBeenCalledWith([expect.objectContaining({ id: 'b1' })])
  })

  it('pullV2Books_ResetMidPull_SkipsAfterPull', async () => {
    const afterPull = vi.fn(async () => {})
    const books = new Map<string, Book>()
    const items = await resetMidCall(reset, { 'GET /me/v2/library/changes': feed(book('b1', 'f1'))[0] }, () => client({ afterPull, books }).pullBooks())
    expect(items).toEqual([])
    expect(afterPull).not.toHaveBeenCalled()
    expect(books.size).toBe(0)
  })

  // #1174: a 404 is remembered as "deleted on the server", so a dropped pull must not answer one.
  it('v2Book_ResetMidPull_RetryableNot404', async () => {
    const c = client()
    const run = resetMidCall(reset, { 'GET /me/v2/library/changes': feed(book('b1', 'f1'))[0] }, () => c.liveBook('b1'))
    await expect(run).rejects.toMatchObject({ status: 503 })
  })

  it('v2Book_CompletedPullWithoutTheBook_404', async () => {
    fakeApi({ 'GET /me/v2/library/changes': feed(book('other', 'f1')) }, API)
    await expect(client().liveBook('b1')).rejects.toMatchObject({ status: 404 })
  })

  // A caller joining a single flight after its keep step, while afterPull still runs, shares a kept pull.
  it('v2Book_JoinsFlightAfterKeepBeforeAfterPull_404Not503', async () => {
    fakeApi({ 'GET /me/v2/library/changes': feed(book('other', 'f1')) }, API)
    let current: Promise<Book[]> | null = null
    const pullFlight = (pull: () => Promise<Book[]>) => (current ??= pull().finally(() => { current = null }))
    let release!: () => void
    let entered!: () => void
    const inAfterPull = new Promise<void>((r) => { entered = r })
    const afterPull = vi.fn(() => { entered(); return new Promise<void>((r) => { release = r }) })
    const c = client({ pullFlight, afterPull })

    const first = c.pullBooks()
    await inAfterPull // the books are kept; afterPull has not resolved
    const joined = c.liveBook('b1')
    release()
    await first
    await expect(joined).rejects.toMatchObject({ status: 404 })
    expect(afterPull).toHaveBeenCalledTimes(1) // it joined, it did not pull again
  })

  it('saveV2Progress_StaleRevision_KeepsTheAdoptedPlace', async () => {
    const current = state('b1', 5, { currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 9 } } })
    fakeApi({ 'PUT /me/v2/books/b1/reading-state': [conflict('stale_revision', { current })] }, API)
    const keepAdopted = vi.fn()
    expect(await client({ keepAdopted }).saveProgress('b1', { chapterSlug: null, locator: 'page:2' })).toEqual({ adopted: expect.objectContaining({ locator: 'page:9' }) })
    expect(keepAdopted).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 }), expect.objectContaining({ locator: 'page:9' }))
  })

  it('saveV2Progress_ResetWhileAdoptResolvesItsChapter_DropsAndKeepsNothing', async () => {
    const current = state('b1', 5, { currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/2)' } })
    const keepAdopted = vi.fn()
    const outcome = await resetMidCall(reset, {
      'PUT /me/v2/books/b1/reading-state': conflict('stale_revision', { current }),
      'GET /me/v2/library/changes': feed(book('b1', 'f1'))[0],
      'GET /me/v2/books/b1/files/f1/chapters': { status: 200, body: { items: [], ingestion: 'succeeded' } },
    }, () => client({ keepAdopted }).saveProgress('b1', { chapterSlug: null, locator: 'page:2' }), '/chapters')
    expect(outcome).toBe('dropped')
    expect(keepAdopted).not.toHaveBeenCalled()
  })

  it('completeV2Book_StateOnCurrentFile_ReadsNoToc', async () => {
    // No /chapters route: a TOC fetch would answer 599 and fail the mark-read.
    const calls = fakeApi({
      'GET /me/v2/library/changes': feed(book('b1', 'f1')),
      'GET /me/v2/books/b1/reading-state': [{ status: 200, body: state('b1', 4) }],
      'PUT /me/v2/books/b1/reading-state': [{ status: 200, body: state('b1', 5) }],
    }, API)
    expect(await client().completeBook('b1')).toBe('done')
    expect(calls.some((c) => c.path.includes('/chapters'))).toBe(false)
  })

  // ADR-033: a never-opened book has no TOC on the server, so mark-read's start names no chapter key.
  it.each([
    ['epub', { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/2)' }],
    ['mobi', { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/2)' }],
    ['pdf', { version: 1, scheme: 'pdf-page', value: { page: 1 } }],
  ])('completeV2Book_NoStateNoToc_%s_WritesTheStartWithoutAChapter', async (format, start) => {
    const calls = fakeApi({
      'GET /me/v2/library/changes': feed(book('b1', 'f1', { currentFile: { id: 'f1', sha256: 'x', byteSize: 3, originalName: 'b', format, hasContent: true } })),
      'GET /me/v2/books/b1/reading-state': [conflict('not_found', {}, 404)],
      'PUT /me/v2/books/b1/reading-state': [{ status: 200, body: state('b1', 1) }],
    }, API)
    expect(await client().completeBook('b1')).toBe('done')
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.body).toMatchObject({ expectedRevision: null, fileId: 'f1', currentLocator: start, bookFraction: 0, completedAt: expect.any(String) })
    expect(calls.some((c) => c.path.includes('/chapters'))).toBe(false)
  })
})
