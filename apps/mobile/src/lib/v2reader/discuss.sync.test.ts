/**
 * "Discuss this chapter" on the device (#1316): what a share of the open bytes names on the server, on a real
 * SQLite against the fake V2 API. The share itself is `createDiscuss` (packages/shared, its own tests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initApi } from '@textstack/shared'
import { resetV2ForTests } from '../v2'
import { createLocalLibrary } from './localLibrary'
import { memoryDb } from './sqliteShim'
import { syncV2Library, type SyncHost } from './sync'
import { fakeApi as fakeV2, feed, type Answer } from '../../../../../packages/shared/src/api/__tests__/fakeSyncApi'

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))
vi.mock('../offlineDb', () => ({ dropReplacedUserBookFiles: async () => [] }))
vi.mock('../originalFileCache', () => ({ deleteOriginal: async () => {} }))

const V2 = 'http://api/me/v2'
const SHA = 'ab'.repeat(32)
let n = 0
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const ok = (body: unknown, status = 200): Answer => ({ status, body })
const host: SyncHost = { userId: 'u1', newId, reader: () => null, guest: false }
const serverBook = (id: string, fileId: string, sha256 = SHA) => ({
  id, title: 'T', author: null, tags: [], hasCover: false, revision: 1, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', removedAt: null,
  currentFile: { id: fileId, sha256, byteSize: 10, originalName: 'b.epub', format: 'epub', hasContent: false, contentRemovedAt: null, isCurrent: true },
})

beforeEach(() => {
  resetV2ForTests()
  initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null })
})
afterEach(() => vi.unstubAllGlobals())

describe('serverBookOf (#1316)', () => {
  it('is null for bytes no book here has', async () => {
    expect(await createLocalLibrary(memoryDb()).serverBookOf(SHA)).toBeNull()
  })

  it('names the book and no file while the server does not hold this file version', async () => {
    const lib = createLocalLibrary(memoryDb())
    await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
    expect(await lib.serverBookOf(SHA)).toEqual({ bookId: await lib.localBookId(SHA), fileId: null })
  })

  it('names the book and its file once the server holds this very version', async () => {
    const lib = createLocalLibrary(memoryDb())
    await lib.addOpened({ sha256: SHA, size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }, newId)
    const bookId = (await lib.localBookId(SHA))!
    const fileId = (await lib.book(bookId))!.file_id!
    fakeV2({
      'GET /status': [ok({ maxPartBytes: 1024 })], 'GET /library/changes': feed(), 'GET /reading/changes': feed(), 'GET /annotations/changes': feed(), 'GET /vocabulary/changes': feed(),
      [`GET /books/by-sha256/${SHA}`]: [{ status: 404 }], [`PUT /books/${bookId}`]: [ok(serverBook(bookId, fileId), 201)],
    }, V2)
    expect(await syncV2Library(lib, host)).toBe('done')
    expect(await lib.serverBookOf(SHA)).toEqual({ bookId, fileId })
  })
})
