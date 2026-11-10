import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initApi } from './client'
import { forgetPulls, type V2Book, type V2FileChapters } from './v2'
import { createV2Books, type V2BooksPlatform } from './v2Books'
import { fakeApi, feed, book, conflict, state, resetMidCall } from './__tests__/fakeV2Api'

const API = 'http://api'

// The optional hooks only mobile passes: web never runs these branches.
describe('the shared V2 book client', () => {
  let epoch = 0
  const reset = () => {
    epoch++
    forgetPulls()
  }
  const client = (extra: Partial<V2BooksPlatform> = {}) => createV2Books({
    books: new Map<string, V2Book>(),
    chapters: new Map<string, V2FileChapters>(),
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
      let current: Promise<V2Book[]> | null = null
      return { run: (pull: () => Promise<V2Book[]>) => (current ??= pull().finally(() => { current = null })) }
    }
    let flight = single()
    const answers: Array<() => void> = []
    const fetchSpy = vi.fn(() => new Promise((resolve) => {
      answers.push(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ items: [], cursor: null, hasMore: false }) }))
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const c = client({ pullFlight: (pull) => flight.run(pull) })

    const first = c.pullV2Books()
    reset()
    flight = single() // as mobile's v2Store.reset: the hook is read per pull, never captured
    const second = c.pullV2Books()
    await new Promise((r) => setTimeout(r, 0))
    for (const a of answers) a()
    await Promise.all([first, second])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('pullV2Books_KeptPull_RunsAfterPullWithItsBooks', async () => {
    fakeApi({ 'GET /me/v2/library/changes': feed(book('b1', 'f1')) }, API)
    const afterPull = vi.fn(async () => {})
    await client({ afterPull }).pullV2Books()
    expect(afterPull).toHaveBeenCalledWith([expect.objectContaining({ id: 'b1' })])
  })

  it('pullV2Books_ResetMidPull_SkipsAfterPull', async () => {
    const afterPull = vi.fn(async () => {})
    const books = new Map<string, V2Book>()
    const items = await resetMidCall(reset, { 'GET /me/v2/library/changes': feed(book('b1', 'f1'))[0] }, () => client({ afterPull, books }).pullV2Books())
    expect(items).toEqual([])
    expect(afterPull).not.toHaveBeenCalled()
    expect(books.size).toBe(0)
  })

  // #1174: a 404 is remembered as "deleted on the server", so a dropped pull must not answer one.
  it('v2Book_ResetMidPull_RetryableNot404', async () => {
    const c = client()
    const run = resetMidCall(reset, { 'GET /me/v2/library/changes': feed(book('b1', 'f1'))[0] }, () => c.v2Book('b1'))
    await expect(run).rejects.toMatchObject({ status: 503 })
  })

  it('v2Book_CompletedPullWithoutTheBook_404', async () => {
    fakeApi({ 'GET /me/v2/library/changes': feed(book('other', 'f1')) }, API)
    await expect(client().v2Book('b1')).rejects.toMatchObject({ status: 404 })
  })

  it('saveV2Progress_StaleRevision_KeepsTheAdoptedPlace', async () => {
    const current = state('b1', 5, { currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 9 } } })
    fakeApi({ 'PUT /me/v2/books/b1/reading-state': [conflict('stale_revision', { current })] }, API)
    const keepAdopted = vi.fn()
    expect(await client({ keepAdopted }).saveV2Progress('b1', { chapterSlug: null, locator: 'page:2' })).toEqual({ adopted: expect.objectContaining({ locator: 'page:9' }) })
    expect(keepAdopted).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 }), expect.objectContaining({ locator: 'page:9' }))
  })

  it('saveV2Progress_ResetWhileAdoptResolvesItsChapter_DropsAndKeepsNothing', async () => {
    const current = state('b1', 5, { currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/2)' } })
    const keepAdopted = vi.fn()
    const outcome = await resetMidCall(reset, {
      'PUT /me/v2/books/b1/reading-state': conflict('stale_revision', { current }),
      'GET /me/v2/library/changes': feed(book('b1', 'f1'))[0],
      'GET /me/v2/books/b1/files/f1/chapters': { status: 200, body: { items: [], ingestion: 'succeeded' } },
    }, () => client({ keepAdopted }).saveV2Progress('b1', { chapterSlug: null, locator: 'page:2' }), '/chapters')
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
    expect(await client().completeV2Book('b1')).toBe('done')
    expect(calls.some((c) => c.path.includes('/chapters'))).toBe(false)
  })
})
