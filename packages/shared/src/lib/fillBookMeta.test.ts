import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initApi } from '../api/client'
import { fillBookMeta } from './fillBookMeta'

const API = 'http://api'
const SHA = 'ab'.repeat(32)
const JPEG = `data:image/jpeg;base64,${btoa('\xff\xd8\xff\xe0jpeg')}`
const MOBY = { title: 'Moby-Dick', author: 'Herman Melville', lang: 'en', description: '' }

type Call = { method: string; path: string; body: unknown }

/** The server: one book with these bytes, as `found`; every write answers 200 (the PATCH as revision 2). */
function server(found: Record<string, unknown>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(API, '')
    calls.push({ method: init.method ?? 'GET', path, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    const book = { ...found, revision: init.method === 'PATCH' ? 2 : found.revision }
    return { ok: true, status: 200, text: async () => JSON.stringify(book) }
  }))
  return calls
}

const oldUpload = (over: Record<string, unknown> = {}) => ({
  id: 'b1', title: 'moby_dick (1)', author: null, language: 'en', description: 'A whale.', hasCover: false, revision: 1, removedAt: null,
  currentFile: { sha256: SHA, originalName: 'moby_dick (1).epub' },
  ...over,
})

// #1426: a book uploaded before the page read files gets what it missed when it is opened, once.
describe('filling a book in on open', () => {
  beforeEach(() => initApi({ baseUrl: API, getAccessToken: async () => 't', onUnauthorized: async () => null }))
  afterEach(() => vi.unstubAllGlobals())

  it('anOldUploadWithItsFileNameAsTitleAndNoCover_GetsTitleAuthorAndCover_OnRevision2', async () => {
    const calls = server(oldUpload())
    const filled = await fillBookMeta(SHA, async () => ({ meta: MOBY, cover: JPEG }))
    expect(calls.map((c) => `${c.method} ${c.path.replace(/^.*\/books\//, '')}`)).toEqual([`GET by-sha256/${SHA}`, 'PUT b1/cover', 'PATCH b1'])
    // Only what was missing: the language and description it had stay as they were.
    expect(calls[2].body).toEqual({ expectedRevision: 1, title: 'Moby-Dick', author: 'Herman Melville' })
    expect(filled?.revision).toBe(2)
  })

  it('anEditedBook_IsNeverTouched', async () => {
    const calls = server(oldUpload({ revision: 2 }))
    const describe = vi.fn(async () => ({ meta: MOBY, cover: JPEG }))
    expect(await fillBookMeta(SHA, describe)).toBeNull()
    expect(describe).not.toHaveBeenCalled()
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('describeFailing_ChangesNothing', async () => {
    for (const describe of [async () => { throw new Error('no page') }, async () => null, async () => ({ meta: null, cover: null })]) {
      const calls = server(oldUpload())
      expect(await fillBookMeta(SHA, describe)).toBeNull()
      expect(calls.map((c) => c.method)).toEqual(['GET'])
    }
  })
})
