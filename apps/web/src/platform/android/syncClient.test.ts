// The upload tests of the Expo app's sync.test.ts (`describe('mobile v2')` and `describe('deviceUploadIo')`), with the
// WebView's file read faked at `@capacitor/core` and `fetch` in place of expo-file-system.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { initApi } from '@textstack/shared'
import { resetSyncForTests, uploadBook, sha256Of, FileUploadError, MAX_DEVICE_PART_BYTES, deviceUploadIo, uploadPicked, type UploadIo, type UploadStaging } from './syncClient'
import { fakeApi as fakeV2, conflict, type Answer, type Call } from '../../../../../packages/shared/src/api/__tests__/fakeSyncApi'

vi.mock('@capacitor/core', () => ({ Capacitor: { convertFileSrc: (uri: string) => `https://localhost/_capacitor_file_${uri.replace('file://', '')}` } }))

const V2 = 'http://api/me/v2'
const fakeApi = (routes: Record<string, Answer[]>) => fakeV2(routes, V2)
const last = <T>(xs: T[]) => xs[xs.length - 1]

const bytes = Uint8Array.from({ length: 25 }, (_, i) => i)
const sha = createHash('sha256').update(bytes).digest('hex')

function io(sent: Uint8Array[] = []): UploadIo {
  return {
    open: () => ({ size: bytes.length, read: (at, n) => bytes.slice(at, at + n), close: () => {} }),
    sendPart: async (_bookId, _fileId, index, part) => {
      sent.push(part)
      return { index, size: part.length }
    },
    yieldNow: async () => {},
  }
}

describe('mobile v2', () => {
  beforeEach(() => {
    resetSyncForTests()
    initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null })
  })
  afterEach(() => vi.unstubAllGlobals())

  // #1143 second review: Cancel while the last part is in flight never completes the upload.
  it('a cancel during the last part removes the book instead of completing it', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls))
    let cancelled = false
    const device: UploadIo = {
      ...deviceUploadIo(() => cancelled),
      open: () => ({ size: bytes.length, read: (at, n) => bytes.slice(at, at + n), close: () => {} }),
      sendPart: async () => { cancelled = true }, // the only part: Cancel lands while it is in flight
    }
    await expect(uploadBook({ uri: 'u', name: 'a.epub' }, 25, device)).rejects.toMatchObject({ aborted: true })
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/content'))).toBe(false)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(last(calls)).toMatchObject({ method: 'DELETE', path: put.path })
  })

  // #1143 review: a cancel during the re-hash after content_mismatch removes the book it imported.
  it('a cancel during the content_mismatch re-hash removes the imported book', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls, [conflict('content_mismatch')]))
    let hashes = 0
    const device: UploadIo = {
      ...io(),
      yieldNow: async () => {
        if (calls.some((c) => c.method === 'POST')) hashes++ // only the re-hash, after complete answered
        if (hashes > 0) throw Object.assign(new Error('Upload cancelled'), { aborted: true })
      },
    }
    await expect(uploadBook({ uri: 'u', name: 'a.epub' }, 25, device)).rejects.toMatchObject({ aborted: true })
    const put = calls.find((c) => c.method === 'PUT')!
    expect(last(calls)).toMatchObject({ method: 'DELETE', path: put.path })
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
    await expect(uploadBook({ uri: 'u', name: 'a.epub' }, 10, device)).rejects.toMatchObject({ aborted: true })
    expect(reads).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a cancelled upload removes the book it imported', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls))
    const cancelled: UploadIo = { ...io(), sendPart: async () => { throw Object.assign(new Error('Upload cancelled'), { aborted: true }) } }
    await expect(uploadBook({ uri: 'u', name: 'a.epub' }, 10, cancelled)).rejects.toMatchObject({ aborted: true })
    const put = calls.find((c) => c.method === 'PUT')!
    expect(last(calls)).toMatchObject({ method: 'DELETE', path: put.path })
  })

  it('hashes the file streamed, imports, sends parts by the server size and completes', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls))
    const sent: Uint8Array[] = []
    const result = await uploadBook({ uri: 'file:///book.epub', name: 'My Book.epub' }, 10, io(sent))
    expect(result.existing).toBe(false)
    expect(sent.map((p) => p.length)).toEqual([10, 10, 5])
    const put = calls.find((c) => c.method === 'PUT' && c.path.startsWith('/books/'))!
    expect(put.body).toMatchObject({ title: 'My Book', file: { sha256: sha, byteSize: 25, format: 'epub' } })
    expect(last(calls)).toMatchObject({ method: 'POST', body: { partCount: 3 } })
  })

  it('a picked book is uploaded from its staged copy with what the page read from it; the copy is gone either way (#1426)', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls))
    const staged = new Set<string>()
    const staging: UploadStaging = {
      copyIn: async () => { staged.add('staging/1.epub'); return { name: 'staging/1.epub', uri: 'file:///v2/staging/1.epub' } },
      remove: (name) => { staged.delete(name) },
    }
    const opened: string[] = []
    const device: UploadIo = { ...io(), open: (uri) => { opened.push(uri); return io().open(uri) } }
    const meta = { title: 'Moby-Dick', author: 'Herman Melville', lang: 'en', description: 'A whale.' }
    const read: string[] = []
    const describe = async (name: string) => { read.push(name); return { meta, cover: null } }

    await uploadPicked({ uri: 'content://picked', name: 'moby_dick (1).epub' }, 25, device, staging, describe)
    expect(opened).toEqual(['file:///v2/staging/1.epub'])
    expect(read).toEqual(['staging/1.epub'])
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ title: 'Moby-Dick', author: 'Herman Melville', language: 'en', description: 'A whale.' })
    expect(staged.size).toBe(0)

    // A failed upload (the server down on the import) still deletes the copy.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })))
    await expect(uploadPicked({ uri: 'content://picked', name: 'a.epub' }, 25, device, staging, describe)).rejects.toBeTruthy()
    expect(staged.size).toBe(0)
  })

  it('sends the bytes to a book imported elsewhere without them', async () => {
    fakeApi({
      ['GET /books/by-sha256/' + sha]: [{ status: 200, body: { id: 'b-meta', currentFile: { id: 'f-meta', hasContent: false } } }],
      'POST /books/b-meta/files/f-meta/content': [{ status: 200, body: {} }],
    })
    const sent: Uint8Array[] = []
    expect(await uploadBook({ uri: 'u', name: 'a.epub' }, 25, io(sent))).toEqual({ bookId: 'b-meta', existing: false })
    expect(sent).toHaveLength(1)
  })

  it('opens the book that already has these bytes instead of importing', async () => {
    const calls = fakeApi({ ['GET /books/by-sha256/' + sha]: [{ status: 200, body: { id: 'b-old', currentFile: { id: 'f', hasContent: true } } }] })
    expect(await uploadBook({ uri: 'u', name: 'a.epub' }, 10, io())).toEqual({ bookId: 'b-old', existing: true })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('re-sends every part once after incomplete_upload, and names the quota', async () => {
    vi.stubGlobal('fetch', wrapIds([], [
      { status: 400, body: { code: 'incomplete_upload', message: 'x' } },
      { status: 200, body: {} },
    ]))
    const sent: Uint8Array[] = []
    await uploadBook({ uri: 'u', name: 'a.pdf' }, 25, io(sent))
    expect(sent).toHaveLength(2)

    resetSyncForTests()
    vi.stubGlobal('fetch', wrapIds([], [{ status: 409, body: { code: 'quota_exceeded', message: 'x', current: { used: 1, limit: 2 } } }]))
    await expect(uploadBook({ uri: 'u', name: 'a.pdf' }, 25, io())).rejects.toBeInstanceOf(FileUploadError)
  })

  it('caps a device part at 8 MB whatever the server takes (RN sends it as base64)', async () => {
    const big = new Uint8Array(MAX_DEVICE_PART_BYTES * 2 + 1)
    const sizes: number[] = []
    vi.stubGlobal('fetch', wrapIds([]))
    await uploadBook({ uri: 'u', name: 'big.pdf' }, 80 * 1024 * 1024, {
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

// #1610: the Expo app opened the file read-only, as Android's default mode creates a missing file (a 0-byte book).
// Here the bytes come through the WebView's fetch, which never creates a file.
describe('deviceUploadIo', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('open_RetainedBookFile_ReadsRangesThroughTheWebView', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return { ok: true, status: 200, blob: async () => new Blob([bytes]) } }))
    const source = await deviceUploadIo(() => false).open('file:///doc/v2/books/abc.epub')
    expect(urls).toEqual(['https://localhost/_capacitor_file_/doc/v2/books/abc.epub'])
    expect(source.size).toBe(25)
    expect(Array.from(await source.read(20, 5))).toEqual([20, 21, 22, 23, 24])
    expect(await sha256Of(source, async () => {})).toBe(sha)
    source.close()
  })

  it('open_MissingFile_Rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob([]) })))
    await expect(deviceUploadIo(() => false).open('file:///doc/v2/books/gone.epub')).rejects.toThrow('404')
  })
})
