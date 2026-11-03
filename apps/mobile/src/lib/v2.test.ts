import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { initApi } from '@textstack/shared'
import { resetV2ForTests, startV2Probe, uploadV2Book, saveV2Progress, sha256Of, V2UploadError, type UploadIo } from './v2'
import { getUserBookLocalProgress, setUserBookV2State, getUserBookV2State } from './progressStorage'

vi.mock('./offlineDb', () => ({ dropReplacedUserBookFile: async () => false }))
vi.mock('./originalFileCache', () => ({ deleteOriginal: async () => {} }))

type Answer = { status: number; body?: unknown }
interface Call { method: string; path: string; body: unknown }

/** A fake API: each `METHOD /path` (under /me/v2, no query) answers its list in turn, the last repeating. */
function fakeApi(routes: Record<string, Answer[]>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('http://api/me/v2', '').split('?')[0]
    const method = init.method ?? 'GET'
    const isJson = typeof init.body === 'string'
    calls.push({ method, path, body: isJson ? JSON.parse(init.body as string) : init.body })
    const list = routes[`${method} ${path}`] ?? [{ status: 404, body: { code: 'not_found', message: 'none' } }]
    const a = list.length > 1 ? list.shift()! : list[0]
    return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) }
  }))
  return calls
}

const bytes = Uint8Array.from({ length: 25 }, (_, i) => i)
const sha = createHash('sha256').update(bytes).digest('hex')

function io(sent: Uint8Array[] = []): UploadIo {
  return {
    open: () => ({ size: bytes.length, read: (at, n) => bytes.slice(at, at + n), close: () => {} }),
    sendPart: async (bookId, fileId, index, part) => {
      sent.push(part)
      return { index, size: part.length }
    },
    yieldNow: async () => {},
  }
}

describe('mobile v2', () => {
  beforeEach(() => {
    resetV2ForTests()
    initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is off for this start when the status route is not mapped', async () => {
    fakeApi({ 'GET /status': [{ status: 404 }] })
    expect((await startV2Probe()).enabled).toBe(false)
  })

  it('hashes the file streamed, imports, sends parts by the server size and completes', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls))
    const sent: Uint8Array[] = []
    const result = await uploadV2Book({ uri: 'file:///book.epub', name: 'My Book.epub' }, 10, io(sent))
    expect(result.existing).toBe(false)
    expect(sent.map((p) => p.length)).toEqual([10, 10, 5])
    const put = calls.find((c) => c.method === 'PUT' && c.path.startsWith('/books/'))!
    expect(put.body).toMatchObject({ title: 'My Book', file: { sha256: sha, byteSize: 25, format: 'epub' } })
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { partCount: 3 } })
  })

  it('sends the bytes to a book imported elsewhere without them', async () => {
    fakeApi({
      ['GET /books/by-sha256/' + sha]: [{ status: 200, body: { id: 'b-meta', currentFile: { id: 'f-meta', hasContent: false } } }],
      'POST /books/b-meta/files/f-meta/content': [{ status: 200, body: {} }],
    })
    const sent: Uint8Array[] = []
    expect(await uploadV2Book({ uri: 'u', name: 'a.epub' }, 25, io(sent))).toEqual({ bookId: 'b-meta', existing: false })
    expect(sent).toHaveLength(1)
  })

  it('opens the book that already has these bytes instead of importing', async () => {
    const calls = fakeApi({ ['GET /books/by-sha256/' + sha]: [{ status: 200, body: { id: 'b-old', currentFile: { id: 'f', hasContent: true } } }] })
    expect(await uploadV2Book({ uri: 'u', name: 'a.epub' }, 10, io())).toEqual({ bookId: 'b-old', existing: true })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('re-sends every part once after incomplete_upload, and names the quota', async () => {
    vi.stubGlobal('fetch', wrapIds([], [
      { status: 400, body: { code: 'incomplete_upload', message: 'x' } },
      { status: 200, body: {} },
    ]))
    const sent: Uint8Array[] = []
    await uploadV2Book({ uri: 'u', name: 'a.pdf' }, 25, io(sent))
    expect(sent).toHaveLength(2)

    resetV2ForTests()
    vi.stubGlobal('fetch', wrapIds([], [{ status: 409, body: { code: 'quota_exceeded', message: 'x', current: { used: 1, limit: 2 } } }]))
    await expect(uploadV2Book({ uri: 'u', name: 'a.pdf' }, 25, io())).rejects.toBeInstanceOf(V2UploadError)
  })

  it('streams the hash in chunks to the same digest', async () => {
    const big = Uint8Array.from({ length: 3 * 1024 * 1024 + 7 }, (_, i) => (i * 13) & 0xff)
    const hex = await sha256Of({ size: big.length, read: (at, n) => big.subarray(at, at + n), close: () => {} }, async () => {})
    expect(hex).toBe(createHash('sha256').update(big).digest('hex'))
  })

  it('a lost reading-state write adopts the server place as this device record', async () => {
    await setUserBookV2State('b1', { revision: 3, fileId: 'f1' })
    const current = {
      bookId: 'b1', fileId: 'f1', revision: 5, bookFraction: 0.4, completedAt: null, frontierLocator: null, frontierFraction: null,
      currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 9 } },
      clientRecordedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:01.000Z', resetRevision: null,
    }
    const calls = fakeApi({ 'PUT /books/b1/reading-state': [{ status: 409, body: { code: 'stale_revision', message: 'x', current } }] })
    expect(await saveV2Progress('b1', { chapterSlug: null, locator: 'page:2', percent: 0.1 })).toEqual({})
    expect(calls[0].body).toMatchObject({ expectedRevision: 3, fileId: 'f1', currentLocator: { scheme: 'pdf-page', value: { page: 2 } } })
    expect(await getUserBookV2State('b1')).toEqual({ revision: 5, fileId: 'f1' })
    expect(await getUserBookLocalProgress('b1')).toMatchObject({ page: 9, bookPercent: 0.4, synced: true })
  })

  it('a replaced file forgets the book and asks for a reload; a missing chapter drops the write', async () => {
    await setUserBookV2State('b1', { revision: 1, fileId: 'f1' })
    fakeApi({ 'PUT /books/b1/reading-state': [
      { status: 409, body: { code: 'chapter_not_found', message: 'x' } },
      { status: 409, body: { code: 'file_replaced', message: 'x' } },
    ] })
    expect(await saveV2Progress('b1', { chapterSlug: 'k1' })).toEqual({ dropped: true })
    expect(await saveV2Progress('b1', { chapterSlug: 'k1' })).toEqual({ reload: true })
    expect(await getUserBookV2State('b1')).toBeNull()
  })
})

/**
 * The upload mints its own book and file ids; this fake answers every import, part and complete
 * whatever they are, and gives `completes` to the content route in turn.
 */
function wrapIds(calls: Call[], completes: Answer[] = [{ status: 200, body: {} }]) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('http://api/me/v2', '')
    const method = init.method ?? 'GET'
    calls.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    let a: Answer = { status: 200, body: {} }
    if (path.startsWith('/books/by-sha256/')) a = { status: 404 }
    else if (method === 'PUT' && /^\/books\/[^/]+$/.test(path)) {
      // The import answers the book with its first file, no bytes yet.
      const sent = JSON.parse(init.body as string)
      a = { status: 201, body: { id: path.slice(7), currentFile: { id: sent.file.id, hasContent: false } } }
    }
    else if (method === 'POST' && path.endsWith('/content')) a = completes.length > 1 ? completes.shift()! : completes[0]
    return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) }
  })
}
