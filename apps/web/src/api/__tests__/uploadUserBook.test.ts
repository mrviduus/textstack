import { describe, it, expect, vi, afterEach } from 'vitest'
import { uploadUserBook, RATE_LIMIT_WAIT_MS } from '../userBooks'
import { startV2Probe, resetV2ForTests, V2UploadError } from '../v2'
import { fakeApi, V2_ON, book } from './fakeV2Api'

// Cloudflare 413s any single request body over ~100 MB before it reaches the API. A file above the
// server's maxSingleUploadBytes must go up as parts + complete; a small one stays one multipart POST.

const MB = 1024 * 1024

interface Sent { method: string; url: string; body: unknown }

const OK = '{"userBookId":"b1","jobId":"j1","status":"Queued"}'

/** Each request takes the next status from `statuses` (the last one repeats). */
function stubXhr(statuses: number[] = [200], response = OK) {
  const sent: Sent[] = []
  class FakeXhr {
    status = 0
    responseText = response
    private method = ''
    private url = ''
    private listeners: Record<string, () => void> = {}
    upload = { addEventListener: () => {} }
    withCredentials = false
    addEventListener(type: string, fn: () => void) { this.listeners[type] = fn }
    open(method: string, url: string) { this.method = method; this.url = url }
    setRequestHeader() {}
    send(body: unknown) {
      sent.push({ method: this.method, url: this.url, body })
      this.status = statuses[Math.min(sent.length - 1, statuses.length - 1)]
      queueMicrotask(() => this.listeners.load?.())
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  return sent
}

function fakeFile(size: number, name = 'book.pdf'): File {
  return { size, name, slice: (start: number, end: number) => ({ start, end }) } as unknown as File
}

function stubQuota() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ maxSingleUploadBytes: 80 * MB }),
    text: async () => JSON.stringify({ maxSingleUploadBytes: 80 * MB }),
  }))
}

describe('uploadUserBook', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sends a small file as one multipart POST, without asking for the quota', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const sent = stubXhr()

    await uploadUserBook(fakeFile(5 * MB))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('POST')
    expect(sent[0].url).toContain('/me/books/upload')
  })

  it('sends a file over the server ceiling as ordered parts, then complete', async () => {
    stubQuota()
    const sent = stubXhr()

    const result = await uploadUserBook(fakeFile(105 * MB))

    // 50 MB parts: 0..50, 50..100, 100..105
    const parts = sent.filter((s) => s.method === 'PUT')
    expect(parts.map((p) => p.url.split('/parts/')[1])).toEqual(['0', '1', '2'])
    expect(parts.map((p) => p.body)).toEqual([
      { start: 0, end: 50 * MB }, { start: 50 * MB, end: 100 * MB }, { start: 100 * MB, end: 105 * MB },
    ])
    const uploadId = parts[0].url.split('/uploads/')[1].split('/')[0]
    expect(parts.every((p) => p.url.includes(`/uploads/${uploadId}/`))).toBe(true)

    const complete = sent[sent.length - 1]
    expect(complete.method).toBe('POST')
    expect(complete.url).toContain(`/me/books/uploads/${uploadId}/complete`)
    expect(JSON.parse(complete.body as string)).toMatchObject({ fileName: 'book.pdf', partCount: 3 })
    expect(result.userBookId).toBe('b1')
  })

  it('explains a 413 instead of surfacing the raw status', async () => {
    stubXhr([413], '<html>413 Request Entity Too Large</html>')

    await expect(uploadUserBook(fakeFile(5 * MB))).rejects.toThrow(/too large/i)
  })

  it('retries a part once after a dropped connection or 5xx', async () => {
    stubQuota()
    const sent = stubXhr([503, 200])

    await uploadUserBook(fakeFile(90 * MB))

    expect(sent.filter((s) => s.url.endsWith('/parts/0'))).toHaveLength(2)
    expect(sent[sent.length - 1].url).toContain('/complete')
  })

  it('frees the server-side parts when a part fails for good', async () => {
    stubQuota()
    const sent = stubXhr([200, 400])

    await expect(uploadUserBook(fakeFile(90 * MB))).rejects.toThrow()

    const last = sent[sent.length - 1]
    expect(last.method).toBe('DELETE')
    expect(last.url).toMatch(/\/me\/books\/uploads\/[^/]+$/)
  })

  it('never retries complete — the first attempt already claimed the parts', async () => {
    stubQuota()
    const sent = stubXhr([200, 200, 503])

    await expect(uploadUserBook(fakeFile(90 * MB))).rejects.toThrow()

    expect(sent.filter((s) => s.url.endsWith('/complete'))).toHaveLength(1)
  })

  it('waits out a 429 from the upload limiter, then retries the part', async () => {
    vi.useFakeTimers()
    try {
      stubQuota()
      const sent = stubXhr([429, 200])

      const done = uploadUserBook(fakeFile(90 * MB))
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WAIT_MS)
      await done

      expect(sent.filter((s) => s.url.endsWith('/parts/0'))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('uploadUserBook on V2', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetV2ForTests()
  })

  it("reads a part's 413 as quota_exceeded, with the used and limit it carries", async () => {
    const B = '00000000-0000-4000-8000-00000000b001'
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(B).mockReturnValueOnce('00000000-0000-4000-8000-00000000f001')
    fakeApi({
      ...V2_ON,
      'GET /me/v2/books/by-sha256/74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0': [{ status: 404 }],
      [`PUT /me/v2/books/${B}`]: [{ status: 201, body: book(B, 'f') }],
    })
    await startV2Probe()
    stubXhr([413], JSON.stringify({ code: 'quota_exceeded', message: 'x', current: { used: 9, limit: 10 } }))

    const error = await uploadUserBook(new File([new Uint8Array([1, 2, 3, 4, 5])], 'b.epub')).catch((e) => e)

    expect(error).toBeInstanceOf(V2UploadError)
    expect(error).toMatchObject({ code: 'quota_exceeded', quota: { used: 9, limit: 10 } })
  })
})
