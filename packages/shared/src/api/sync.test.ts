import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initApi, ApiError } from './client'
import * as v2 from './sync'

/** Each call takes the next answer; records what was sent. */
function stubFetch(...answers: { status: number; body?: unknown }[]) {
  const fetchMock = vi.fn()
  for (const a of answers) {
    fetchMock.mockResolvedValueOnce({
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)),
    })
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const sent = (fetchMock: ReturnType<typeof vi.fn>, i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit]
  return { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined }
}

describe('v2 api', () => {
  beforeEach(() => {
    initApi({ baseUrl: 'http://api', getAccessToken: async () => null, onUnauthorized: async () => null, credentials: 'include' })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('puts a reading state at the book route with the body as given', async () => {
    const fetchMock = stubFetch({ status: 200, body: { revision: 1 } })
    const body = {
      expectedRevision: null, fileId: 'f1', bookFraction: 0.5, clientRecordedAt: '2026-11-02T00:00:00.000Z',
      currentLocator: { version: 1 as const, scheme: 'textstack-position-v1', value: { v: 1, chapterSlug: 'one', chapterFraction: 0.5 } },
    }

    await v2.putReadingState('b1', body)

    expect(sent(fetchMock)).toEqual({ url: 'http://api/me/v2/books/b1/reading-state', method: 'PUT', body })
  })

  it('asks for reading stats by period in the given time zone', async () => {
    const body = { period: 'month', from: '2026-11-01', to: '2026-11-30', minutes: 0, daysRead: 0, currentStreak: 0, bestStreak: 0, bars: [] }
    const fetchMock = stubFetch({ status: 200, body })

    expect(await v2.readingStats('month', 'Europe/Kyiv')).toEqual(body)

    expect(sent(fetchMock)).toEqual({ url: 'http://api/me/v2/stats?period=month&tz=Europe%2FKyiv', method: 'GET', body: undefined })
  })

  it('reading stats default to the device time zone', async () => {
    const fetchMock = stubFetch({ status: 200, body: {} })
    await v2.readingStats('week')
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(sent(fetchMock).url).toBe(`http://api/me/v2/stats?period=week&tz=${encodeURIComponent(tz)}`)
  })

  it('reading stats send UTC when the runtime knows no time zone', async () => {
    const fetchMock = stubFetch({ status: 200, body: {} })
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: '' } as Intl.ResolvedDateTimeFormatOptions)
    await v2.readingStats('week')
    expect(sent(fetchMock).url).toBe('http://api/me/v2/stats?period=week&tz=UTC')
  })

  it('pulls a feed page by page until hasMore is false and returns the last cursor', async () => {
    const fetchMock = stubFetch(
      { status: 200, body: { items: [1, 2], cursor: 'c1', hasMore: true } },
      { status: 200, body: { items: [3], cursor: 'c2', hasMore: false } },
    )

    const all = await v2.pullAll<number>('library')

    expect(all).toEqual({ items: [1, 2, 3], cursor: 'c2' })
    expect(sent(fetchMock, 0).url).toBe('http://api/me/v2/library/changes')
    expect(sent(fetchMock, 1).url).toBe('http://api/me/v2/library/changes?cursor=c1')
  })

  it('answers null for a sha256 the library does not hold and for a book with no reading state', async () => {
    stubFetch({ status: 404, body: { code: 'not_found', message: 'none' } }, { status: 404, body: { code: 'not_found', message: 'none' } })

    expect(await v2.findBySha256('ab')).toBeNull()
    expect(await v2.getReadingState('b1')).toBeNull()
  })

  it('carries the 409 body on the error, readable as a SyncError', async () => {
    const current = { revision: 7, fileId: 'f1' }
    stubFetch({ status: 409, body: { code: 'stale_revision', message: 'Another device saved a newer position.', revision: 7, current } })

    const error = await v2.putAnnotation('a1', { expectedRevision: 1, bookId: 'b1', selectedText: 'x', color: 'yellow' }).catch((e) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(409)
    expect(v2.syncErrorOf(error)).toMatchObject({ code: 'stale_revision', revision: 7, current })
  })

  it('reads no V2 error from a network failure or a non-V2 body', async () => {
    const offline = new ApiError(0, 'offline')
    offline.isNetworkError = true
    expect(v2.syncErrorOf(offline)).toBeNull()
    expect(v2.syncErrorOf(new Error('x'))).toBeNull()
  })

  it('probes on with the part size, off on 404, 503 or offline, and rethrows a 401', async () => {
    stubFetch({ status: 200, body: { maxPartBytes: 1024 } })
    expect(await v2.probeSync()).toEqual({ enabled: true, maxPartBytes: 1024 })

    stubFetch({ status: 404 })
    expect((await v2.probeSync()).enabled).toBe(false)

    stubFetch({ status: 503, body: { code: 'v2_unavailable', message: 'paused' } })
    expect((await v2.probeSync()).enabled).toBe(false)

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network request failed')))
    expect((await v2.probeSync()).enabled).toBe(false)

    stubFetch({ status: 401 })
    await expect(v2.probeSync()).rejects.toMatchObject({ status: 401 })
  })

  it('posts a review with its own operation id, and builds the content and cover URLs on the API base', async () => {
    const fetchMock = stubFetch({ status: 201, body: {} })
    const review = { operationId: 'op1', wordId: 'w1', reviewMode: 'classic', isCorrect: true, clientRecordedAt: '2026-11-02T00:00:00.000Z' }

    await v2.recordReview(review)

    expect(sent(fetchMock)).toEqual({ url: 'http://api/me/v2/vocabulary/reviews', method: 'POST', body: review })
    expect(v2.contentUrl('b1', 'f1')).toBe('http://api/me/v2/books/b1/files/f1/content')
    expect(v2.coverUrl('b1', '2026-11-02T00:00:00Z')).toBe('http://api/me/v2/books/b1/cover?v=2026-11-02T00%3A00%3A00Z')
  })

  // #1584: a TOC sync or an edit moves the book's updatedAt, never its cover's URL; a server before #1584 still keys by updatedAt.
  it('keys a book cover by its own version, falling back to updatedAt; none without a cover', () => {
    const b = { id: 'b1', hasCover: true, coverVersion: '2026-11-01T00:00:00Z', updatedAt: '2026-11-24T00:00:00Z' }
    expect(v2.bookCoverUrl(b)).toBe('http://api/me/v2/books/b1/cover?v=2026-11-01T00%3A00%3A00Z')
    expect(v2.bookCoverUrl({ ...b, coverVersion: undefined })).toBe('http://api/me/v2/books/b1/cover?v=2026-11-24T00%3A00%3A00Z')
    expect(v2.bookCoverUrl({ ...b, hasCover: false })).toBeNull()
  })

  describe('getContent (#1227)', () => {
    const streamOf = (parts: number[][], breakOff = false) => new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new Uint8Array(p))
        if (breakOff) c.error(new TypeError('network error'))
        else c.close()
      },
    })

    it('streams the bytes with progress against Content-Length', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(streamOf([[1, 2], [3]]), { headers: { 'Content-Length': '3' } })))
      const progress: [number, number | null][] = []
      const bytes = await v2.getContent('b1', 'f1', (l, t) => progress.push([l, t]))
      expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3])
      expect(progress).toEqual([[2, 3], [3, 3]])
    })

    it('no Content-Length: progress with a null total', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(streamOf([[7]]))))
      const progress: [number, number | null][] = []
      await v2.getContent('b1', 'f1', (l, t) => progress.push([l, t]))
      expect(progress).toEqual([[1, null]])
    })

    it('a body that breaks off is a network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(streamOf([[1]], true))))
      const e = await v2.getContent('b1', 'f1', () => {}).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).isNetworkError).toBe(true)
    })

    it('an onProgress throw keeps its own cause, not offline', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(streamOf([[1]]))))
      const e = await v2.getContent('b1', 'f1', () => { throw new RangeError('no memory') }).catch((x: unknown) => x)
      expect(e).toBeInstanceOf(RangeError)
    })

    it('an abort is the AbortError it is, not offline', async () => {
      const abort = new DOMException('aborted', 'AbortError')
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1])); c.error(abort) } })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
      const e = await v2.getContent('b1', 'f1', () => {}).catch((x: unknown) => x)
      expect((e as Error).name).toBe('AbortError')
      expect(e).not.toBeInstanceOf(ApiError)
    })

    it('an abort before the headers is the AbortError it is, not offline', async () => {
      const abort = new AbortController()
      vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => {
        if (init.signal!.aborted) reject(init.signal!.reason)
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
      })))
      const got = v2.getContent('b1', 'f1', () => {}, abort.signal).catch((x: unknown) => x)
      abort.abort()
      const e = await got
      expect((e as Error).name).toBe('AbortError')
      expect(e).not.toBeInstanceOf(ApiError)
    })

    it('the signal goes to the request', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(streamOf([[1]])))
      vi.stubGlobal('fetch', fetchMock)
      const signal = new AbortController().signal
      await v2.getContent('b1', 'f1', () => {}, signal)
      expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(signal)
    })

    it.each([
      ['shorter', '5', [[1, 2], [3]], [1, 2, 3]],
      ['longer', '2', [[1, 2], [3, 4]], [1, 2, 3, 4]],
      ['crossing it mid-chunk', '3', [[1, 2], [3, 4]], [1, 2, 3, 4]],
    ])('a Content-Length the body is %s than: the bytes as they came', async (_, length, parts, bytes) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(streamOf(parts), { headers: { 'Content-Length': length } })))
      const out = await v2.getContent('b1', 'f1', () => {})
      expect([...new Uint8Array(out)]).toEqual(bytes)
      expect(out.byteLength).toBe(bytes.length)
    })

    it('a 404 stays the 404 it is', async () => {
      stubFetch({ status: 404, body: { code: 'file_not_found', message: 'gone' } })
      const e = await v2.getContent('b1', 'f1', () => {}).catch((x: unknown) => x)
      expect((e as ApiError).status).toBe(404)
      expect((e as ApiError).isNetworkError).toBeFalsy()
    })
  })

  it('pullFeed_OldAccountPullSettlesAfterSignOut_NewAccountPullStaysShared', async () => {
    const answers: Array<() => void> = []
    const fetchMock = vi.fn(() => new Promise((resolve) => answers.push(() =>
      resolve({ ok: true, status: 200, text: async () => JSON.stringify({ items: [], cursor: null, hasMore: false }) }))))
    vi.stubGlobal('fetch', fetchMock)
    const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

    const alices = v2.pullFeed('library')
    await flush()
    v2.forgetPulls() // Alice signs out, Bob signs in
    const bobs = v2.pullFeed('library')
    await flush()
    answers[0]() // Alice's pull settles late
    await alices

    expect(v2.pullFeed('library')).toBe(bobs) // Bob's second caller joins his pull
    expect(fetchMock).toHaveBeenCalledTimes(2)
    answers[1]()
    await bobs
    v2.forgetPulls()
  })
})
