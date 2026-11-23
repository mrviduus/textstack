import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initApi } from './client'
import { formatOfName, uploadFile, UploadNotOnServer } from './upload'
import type { Call } from './__tests__/fakeSyncApi'

const API = 'http://api'

// The cancel cleanup (mobile's): web never throws an `aborted` error.
describe('the shared V2 upload', () => {
  beforeEach(() => initApi({ baseUrl: API, getAccessToken: async () => 't', onUnauthorized: async () => null }))
  afterEach(() => vi.unstubAllGlobals())

  let n = 0
  const io = (sendPart: () => Promise<unknown>) => ({ newId: () => `id-${++n}`, hash: async () => 'abc', sendPart })
  const routes = (calls: Call[]) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.replace(API, '')
      calls.push({ method: init.method ?? 'GET', path, body: null })
      const status = path.includes('/by-sha256/') ? 404 : 200
      return { ok: status < 300, status, text: async () => (path.includes('/by-sha256/') ? '' : '{}') }
    }))
  }

  it('uploadV2File_CancelAfterImport_RemovesTheImportedBook', async () => {
    const calls: Call[] = []
    routes(calls)
    const cancelled = Object.assign(new Error('Upload cancelled'), { aborted: true })
    await expect(uploadFile({ name: 'a.epub', size: 3 }, 3, io(async () => { throw cancelled }))).rejects.toBe(cancelled)
    const imported = calls.find((c) => c.method === 'PUT')!
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: imported.path })
  })

  it('uploadV2File_NullRejection_RethrowsItUnmasked', async () => {
    const calls: Call[] = []
    routes(calls)
    await expect(uploadFile({ name: 'a.epub', size: 3 }, 3, io(() => Promise.reject(null)))).rejects.toBeNull()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('uploadV2File_KnownBookNotOnTheServer_ThrowsAndImportsNothing', async () => {
    const calls: Call[] = []
    routes(calls)
    const known = { bookId: 'b1', fileId: 'f1' }
    await expect(uploadFile({ name: 'a.epub', size: 3 }, 3, { ...io(async () => {}), known })).rejects.toBeInstanceOf(UploadNotOnServer)
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('uploadV2File_FormatGivenOrByExtension_SentOnTheImport', async () => {
    const bodies: { file: { format: string } }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (init.method === 'PUT' && !url.includes('/parts/')) bodies.push(JSON.parse(String(init.body)))
      const status = url.includes('/by-sha256/') ? 404 : 200
      return { ok: status < 300, status, text: async () => (status === 404 ? '' : '{}') }
    }))
    await uploadFile({ name: 'a.epub', size: 3, format: 'mobi' }, 3, io(async () => {}))
    await uploadFile({ name: 'b.FB2', size: 3 }, 3, io(async () => {}))
    expect(bodies.map((b) => b.file.format)).toEqual(['mobi', 'fb2'])
    expect(formatOfName('x.fbz')).toBe('fb2')
    expect(formatOfName('x.pdf')).toBe('pdf')
    expect(formatOfName('x.bin')).toBe('epub')
  })

  // #1426: the book's details come from its file; an upload never depends on reading them.
  describe('a book read by the reader page on upload', () => {
    const record = (calls: { method: string; path: string; body: unknown }[]) =>
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
        const path = url.replace(API, '')
        calls.push({ method: init.method ?? 'GET', path, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
        const status = path.includes('/by-sha256/') ? 404 : 200
        return { ok: status < 300, status, text: async () => (status === 404 ? '' : '{}') }
      }))
    const JPEG = `data:image/jpeg;base64,${btoa('\xff\xd8\xff\xe0jpeg')}`

    it('importsItsTitleAuthorDescriptionAndToc_AndSendsItsCoverAfterTheBytes', async () => {
      const calls: { method: string; path: string; body: unknown }[] = []
      record(calls)
      const meta = { title: 'Moby-Dick', author: 'Herman Melville', lang: 'en', description: 'A whale.' }
      const toc = [{ key: 'toc-0', title: 'Loomings', depth: 0, fraction: 0.02 }]
      await uploadFile({ name: 'moby_dick (1).epub', size: 3 }, 3, { ...io(async () => {}), describe: async () => ({ meta, cover: JPEG, toc: [...toc, { key: 'toc-0', title: 'twin', depth: 0, fraction: 0 }] }) })
      const imported = calls.find((c) => c.method === 'PUT' && /\/books\/[^/]+$/.test(c.path))!
      expect(imported.body).toMatchObject({ title: 'Moby-Dick', author: 'Herman Melville', language: 'en', description: 'A whale.', file: { toc } })
      const complete = calls.findIndex((c) => c.path.endsWith('/content'))
      expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: `${imported.path}/cover` })
      expect(calls.length - 1).toBeGreaterThan(complete)
      expect([...(calls.at(-1)!.body as Uint8Array)].slice(0, 3)).toEqual([0xff, 0xd8, 0xff])
    })

    it('describeFailsOrHasNothing_StillUploads_UnderTheCleanedFileName', async () => {
      for (const describe of [async () => { throw new Error('no page') }, async () => null, async () => ({ meta: null, cover: null })]) {
        const calls: { method: string; path: string; body: unknown }[] = []
        record(calls)
        await uploadFile({ name: 'moby_dick (1).epub', size: 3 }, 3, { ...io(async () => {}), describe })
        const imported = calls.find((c) => c.method === 'PUT' && /\/books\/[^/]+$/.test(c.path))!
        expect(imported.body).toEqual(expect.objectContaining({ title: 'moby dick' }))
        expect(imported.body).not.toHaveProperty('author')
        expect((imported.body as { file: object }).file).not.toHaveProperty('toc')
        expect(calls.some((c) => c.path.endsWith('/content'))).toBe(true)
        expect(calls.some((c) => c.path.endsWith('/cover'))).toBe(false)
      }
    })
  })
})
