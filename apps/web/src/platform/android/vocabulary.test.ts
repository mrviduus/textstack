// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@textstack/shared'
import { createLocalLibrary, type LocalLibrary } from './localLibrary'
import { memoryDb } from './sqliteShim'

// The device library is a real one over node:sqlite; the server (the web calls) and the session are faked.
let lib: LocalLibrary
let token: string | null = 'at'
let serverHighlights: () => Promise<unknown> = async () => ({ items: [{ id: 'server' }], totalCount: 1 })
const offline = () => Object.assign(new ApiError(0, 'Failed to fetch'), { isNetworkError: true })
const card = { id: 'w1', word: 'quay', language: 'en', stage: 0, translation: 'причал' }

vi.mock('./api', () => ({ getAccessToken: async () => token }))
vi.mock('./account', () => ({ storedUser: async () => ({ id: 'u1' }) }))
vi.mock('./syncClient', () => ({ resetSince: () => () => false }))
vi.mock('./deviceLibrary', () => ({ deviceLocalLibrary: () => lib }))
vi.mock('../../api/vocabulary', () => ({ saveWord: async () => ({ outcome: 'saved', word: card }) }))
vi.mock('@textstack/shared', async (orig) => ({
  ...(await orig<typeof import('@textstack/shared')>()),
  highlightsApi: { getAllHighlights: () => serverHighlights() },
}))

const { vocabulary, highlights } = await import('./vocabulary')

describe('the Android vocabulary and highlights', () => {
  beforeEach(() => {
    lib = createLocalLibrary(memoryDb())
    token = 'at'
  })

  it('saveWord_TheServerAnswersACard_ItIsMarkedFromTheDeviceWithNoNetwork', async () => {
    await vocabulary.saveWord({ word: 'quay', language: 'en' } as never)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await vocabulary.getReaderVocab()).toEqual([{ id: 'w1', word: 'quay', stage: 0, translation: 'причал', language: 'en' }])
    expect(fetch).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('getReaderVocab_AnotherAccountsLibrary_NoMarks', async () => {
    await vocabulary.saveWord({ word: 'quay', language: 'en' } as never)
    await lib.setAccount('someone-else')
    expect(await vocabulary.getReaderVocab()).toEqual([])
  })

  it('getAllHighlights_OnlineTheServers_OfflineThisDevices', async () => {
    expect((await highlights.getAllHighlights()).items).toEqual([{ id: 'server' }])
    const SHA = 'cd'.repeat(32)
    let n = 0
    const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
    await lib.addOpened({ sha256: SHA, size: 10, title: 'Dune', author: '', originalName: 'b.epub', format: 'epub' }, newId)
    const hl = { id: '0b6a2c1e-1111-4222-8333-444455556666', cfi: 'epubcfi(/6/14!/4/2/1:0)', index: 6, quote: 'bright', selectedText: 'bright cold', prefix: 'a ', suffix: ' day', color: 'yellow', at: 1 }
    await lib.writeEntry(SHA, JSON.stringify({ v: 1, book: { sha256: SHA, size: 10, name: 'b.epub' }, position: null, highlights: [hl] }), newId)
    serverHighlights = async () => { throw offline() }
    const offlineList = await highlights.getAllHighlights()
    expect(offlineList.items).toMatchObject([{ id: hl.id, selectedText: 'bright cold', userBookTitle: 'Dune', color: 'yellow' }])
    token = null
    expect((await highlights.getAllHighlights()).totalCount).toBe(1)
  })

  it('coverUrl_NoCover_NullNeverThrows', () => {
    expect(highlights.coverUrl({ userBookId: null, userBookCoverVersion: null })).toBeNull()
  })
})
