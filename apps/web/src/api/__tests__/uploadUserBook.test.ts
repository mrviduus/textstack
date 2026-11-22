import { describe, it, expect, vi, afterEach } from 'vitest'
import { uploadUserBook } from '../userBooks'
import { startV2Probe, resetV2ForTests, FileUploadError } from '../v2'
import { fakeApi, SYNC_ON, book } from '../../../../../packages/shared/src/api/__tests__/fakeSyncApi'
// The reader page is not in jsdom: no details read, as when it fails.
vi.mock('../../lib/describeBook', () => ({ describeBook: async () => null }))

interface Sent { method: string; url: string; body: unknown }

/** Each request takes the next status from `statuses` (the last one repeats). */
function stubXhr(statuses: number[], response: string) {
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

describe('uploadUserBook', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetV2ForTests()
  })

  it("reads a part's 413 as quota_exceeded, with the used and limit it carries", async () => {
    const B = '00000000-0000-4000-8000-00000000b001'
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(B).mockReturnValueOnce('00000000-0000-4000-8000-00000000f001')
    fakeApi({
      ...SYNC_ON,
      'GET /me/v2/books/by-sha256/74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0': [{ status: 404 }],
      [`PUT /me/v2/books/${B}`]: [{ status: 201, body: book(B, 'f') }],
    })
    await startV2Probe()
    stubXhr([413], JSON.stringify({ code: 'quota_exceeded', message: 'x', current: { used: 9, limit: 10 } }))

    const error = await uploadUserBook(new File([new Uint8Array([1, 2, 3, 4, 5])], 'b.epub')).catch((e) => e)

    expect(error).toBeInstanceOf(FileUploadError)
    expect(error).toMatchObject({ code: 'quota_exceeded', quota: { used: 9, limit: 10 } })
  })
})
