/**
 * ADR-033 P3 on the device: a synced book opened in the reader gives the server its contents when the server has
 * none, against the fake V2 API. Nothing else asks or sends anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initApi } from '@textstack/shared'
import { syncOpenedToc } from './openedToc'
import { fakeApi, book, file } from '../../../../../packages/shared/src/api/__tests__/fakeSyncApi'

const V2 = 'http://api/me/v2'
const SHA = 'ab'.repeat(32)
const TOC = [{ key: 'toc-0', title: 'One', depth: 0, fraction: 0 }]
const page = async () => TOC
const here = (fileId: string | null) => async () => ({ bookId: 'b1', fileId })
const onServer = (hasToc: boolean, fileId = 'f1') => ({ status: 200, body: book('b1', fileId, { currentFile: file(fileId, { sha256: SHA, hasToc }) }) })

describe('a synced book opened on the phone', () => {
  beforeEach(() => initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null }))
  afterEach(() => vi.unstubAllGlobals())

  it('itsServerFileWithoutContents_GetsThePagesToc_OneWithContents_Nothing', async () => {
    let calls = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [onServer(false)], 'PUT /books/b1/files/f1/toc': [{ status: 204 }] }, V2)
    expect(await syncOpenedToc(SHA, here('f1'), page)).toBe(true)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /books/by-sha256/${SHA}`, 'PUT /books/b1/files/f1/toc'])
    expect(calls[1].body).toEqual(TOC)

    calls = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [onServer(true)] }, V2)
    expect(await syncOpenedToc(SHA, here('f1'), page)).toBe(false)
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('aBookNotOnTheServer_OrAnotherVersionThere_OrOffline_SendsNothing', async () => {
    let calls = fakeApi({}, V2)
    expect(await syncOpenedToc(SHA, here(null), page)).toBe(false)
    expect(calls).toEqual([])

    calls = fakeApi({ [`GET /books/by-sha256/${SHA}`]: [onServer(false, 'f2')] }, V2)
    expect(await syncOpenedToc(SHA, here('f1'), page)).toBe(false)
    expect(calls.map((c) => c.method)).toEqual(['GET'])

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    await expect(syncOpenedToc(SHA, here('f1'), page)).resolves.toBe(false)
  })
})
