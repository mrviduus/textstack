import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initApi } from './client'
import { uploadV2File } from './v2Upload'
import type { Call } from './__tests__/fakeV2Api'

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
    await expect(uploadV2File({ name: 'a.epub', size: 3 }, 3, io(async () => { throw cancelled }))).rejects.toBe(cancelled)
    const imported = calls.find((c) => c.method === 'PUT')!
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: imported.path })
  })

  it('uploadV2File_NullRejection_RethrowsItUnmasked', async () => {
    const calls: Call[] = []
    routes(calls)
    await expect(uploadV2File({ name: 'a.epub', size: 3 }, 3, io(() => Promise.reject(null)))).rejects.toBeNull()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })
})
