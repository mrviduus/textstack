import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { initApi } from '@textstack/shared'
import NetInfo from '@react-native-community/netinfo'
import { resetV2ForTests, startV2Probe, reprobeV2AfterReconnect, uploadV2Book, saveV2Progress, sha256Of, V2UploadError, MAX_DEVICE_PART_BYTES, pullV2Books, switched, deviceUploadIo, type UploadIo } from './v2'
import { getUserBookLocalProgress, setUserBookV2State, getUserBookV2State } from './progressStorage'
import { fakeApi as fakeV2, conflict, state, type Answer, type Call } from '../../../../packages/shared/src/api/__tests__/fakeV2Api'

const dropReplaced = vi.hoisted(() => ({ runs: 0 }))
vi.mock('./offlineDb', () => ({ dropReplacedUserBookFiles: async () => { dropReplaced.runs++; return [] } }))
vi.mock('./originalFileCache', () => ({ deleteOriginal: async () => {} }))

const V2 = 'http://api/me/v2'
const fakeApi = (routes: Record<string, Answer[]>) => fakeV2(routes, V2)

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

  it('is off for this start when the status route is not mapped, even after a reconnect', async () => {
    const calls = fakeApi({ 'GET /status': [{ status: 404 }] })
    expect((await startV2Probe()).enabled).toBe(false)
    expect((await reprobeV2AfterReconnect()).enabled).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('asks again on a reconnect when the probe never reached the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    expect((await startV2Probe()).enabled).toBe(false)
    expect((await startV2Probe()).enabled).toBe(false) // no retry per call while offline
    fakeApi({ 'GET /status': [{ status: 200, body: { maxPartBytes: 1024 } }] })
    expect(await reprobeV2AfterReconnect()).toEqual({ enabled: true, maxPartBytes: 1024 })
  })

  // #1141: a screen's reconnect effect runs before AuthContext's re-probe; the NetInfo event already marked the offline answer stale.
  it('switched after a reconnect asks the probe again instead of answering the offline one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    expect((await startV2Probe()).enabled).toBe(false)
    const calls = fakeApi({ 'GET /status': [{ status: 200, body: { maxPartBytes: 1024 } }] })
    const call = switched(async () => 'v2', async () => 'legacy')
    ;(NetInfo as unknown as { __emit(s: object): void }).__emit({ isConnected: false, isInternetReachable: false })
    expect(await call()).toBe('legacy') // still offline: no new probe
    expect(calls).toHaveLength(0)
    ;(NetInfo as unknown as { __emit(s: object): void }).__emit({ isConnected: true, isInternetReachable: true })
    expect(await call()).toBe('v2')
    expect(calls.map((c) => c.path)).toEqual(['/status'])
  })

  // #1140: the feed pull is shared, and so is its cleanup — one transaction per pull, not one per caller.
  it('concurrent library pulls run the replaced-file cleanup once', async () => {
    dropReplaced.runs = 0
    const calls = fakeApi({ 'GET /library/changes': [{ status: 200, body: { items: [], cursor: null, hasMore: false } }] })
    await Promise.all([pullV2Books(), pullV2Books(), pullV2Books()])
    expect(calls).toHaveLength(1)
    expect(dropReplaced.runs).toBe(1)
    await pullV2Books() // the next pull is a new one
    expect(dropReplaced.runs).toBe(2)
  })

  // #1143: Cancel during the hash stops within one chunk, before any request.
  it('a cancel during hashing stops after the current chunk', async () => {
    const big = new Uint8Array(4 * 1024 * 1024)
    let reads = 0
    let cancelled = false
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const device: UploadIo = {
      ...deviceUploadIo(() => cancelled),
      open: () => ({ size: big.length, read: (at, n) => { reads++; cancelled = true; return big.subarray(at, at + n) }, close: () => {} }),
    }
    await expect(uploadV2Book({ uri: 'u', name: 'a.epub' }, 10, device)).rejects.toMatchObject({ aborted: true })
    expect(reads).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a write that knows no percent yet keeps the fraction the server holds', async () => {
    await setUserBookV2State('b1', { revision: 2, fileId: 'f1', bookFraction: 0.6 })
    const calls = fakeApi({ 'PUT /books/b1/reading-state': [{ status: 200, body: { bookId: 'b1', fileId: 'f1', revision: 3, bookFraction: 0.6 } }] })
    expect(await saveV2Progress('b1', { chapterSlug: 'k1' })).toBe('accepted')
    expect(calls[0].body).toMatchObject({ expectedRevision: 2, bookFraction: 0.6 })
  })

  it('a cancelled upload removes the book it imported', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls))
    const cancelled: UploadIo = { ...io(), sendPart: async () => { throw Object.assign(new Error('Upload cancelled'), { aborted: true }) } }
    await expect(uploadV2Book({ uri: 'u', name: 'a.epub' }, 10, cancelled)).rejects.toMatchObject({ aborted: true })
    const put = calls.find((c) => c.method === 'PUT')!
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: put.path })
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

  it('caps a device part at 8 MB whatever the server takes (RN sends it as base64)', async () => {
    const big = new Uint8Array(MAX_DEVICE_PART_BYTES * 2 + 1)
    const sizes: number[] = []
    vi.stubGlobal('fetch', wrapIds([]))
    await uploadV2Book({ uri: 'u', name: 'big.pdf' }, 80 * 1024 * 1024, {
      open: () => ({ size: big.length, read: (at, n) => big.subarray(at, at + n), close: () => {} }),
      sendPart: async (_b, _f, _i, part) => { sizes.push(part.length) },
      yieldNow: async () => {},
    })
    expect(sizes).toEqual([MAX_DEVICE_PART_BYTES, MAX_DEVICE_PART_BYTES, 1])
  })

  it('streams the hash in chunks to the same digest', async () => {
    const big = Uint8Array.from({ length: 3 * 1024 * 1024 + 7 }, (_, i) => (i * 13) & 0xff)
    const hex = await sha256Of({ size: big.length, read: (at, n) => big.subarray(at, at + n), close: () => {} }, async () => {})
    expect(hex).toBe(createHash('sha256').update(big).digest('hex'))
  })

  it('a lost reading-state write adopts the server place as this device record', async () => {
    await setUserBookV2State('b1', { revision: 3, fileId: 'f1' })
    const current = state('b1', 5, { bookFraction: 0.4, currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 9 } } })
    const calls = fakeApi({ 'PUT /books/b1/reading-state': [conflict('stale_revision', { current })] })
    expect(await saveV2Progress('b1', { chapterSlug: null, locator: 'page:2', percent: 0.1 })).toEqual({ adopted: expect.objectContaining({ locator: 'page:9' }) })
    expect(calls[0].body).toMatchObject({ expectedRevision: 3, fileId: 'f1', currentLocator: { scheme: 'pdf-page', value: { page: 2 } } })
    expect(await getUserBookV2State('b1')).toEqual({ revision: 5, fileId: 'f1', bookFraction: 0.4 })
    expect(await getUserBookLocalProgress('b1')).toMatchObject({ page: 9, bookPercent: 0.4, synced: true })
  })

  it('a replaced file forgets the book and asks for a reload; a missing chapter drops the write', async () => {
    await setUserBookV2State('b1', { revision: 1, fileId: 'f1' })
    fakeApi({ 'PUT /books/b1/reading-state': [
      conflict('chapter_not_found'),
      conflict('file_replaced'),
    ] })
    expect(await saveV2Progress('b1', { chapterSlug: 'k1' })).toBe('dropped')
    expect(await saveV2Progress('b1', { chapterSlug: 'k1' })).toBe('reload')
    expect(await getUserBookV2State('b1')).toBeNull()
  })
})

/**
 * The upload mints its own book and file ids; this fake answers every import, part and complete
 * whatever they are, and gives `completes` to the content route in turn.
 */
function wrapIds(calls: Call[], completes: Answer[] = [{ status: 200, body: {} }]) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(V2, '')
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
