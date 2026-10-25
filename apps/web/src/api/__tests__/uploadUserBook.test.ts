import { describe, it, expect, vi, afterEach } from 'vitest'
import { uploadUserBook } from '../userBooks'

// Cloudflare 413s any single request body over ~100 MB before it reaches the API. A file above the
// server's maxSingleUploadBytes must go up as parts + complete; a small one stays one multipart POST.

const MB = 1024 * 1024

interface Sent { method: string; url: string; body: unknown }

function stubXhr(status = 200, response = '{"userBookId":"b1","jobId":"j1","status":"Queued"}') {
  const sent: Sent[] = []
  class FakeXhr {
    status = status
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
      queueMicrotask(() => this.listeners.load?.())
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  return sent
}

function fakeFile(size: number, name = 'book.pdf'): File {
  return { size, name, slice: (start: number, end: number) => ({ start, end }) } as unknown as File
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ maxSingleUploadBytes: 80 * MB }),
      text: async () => JSON.stringify({ maxSingleUploadBytes: 80 * MB }),
    }))
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
    stubXhr(413, '<html>413 Request Entity Too Large</html>')

    await expect(uploadUserBook(fakeFile(5 * MB))).rejects.toThrow(/too large/i)
  })
})
