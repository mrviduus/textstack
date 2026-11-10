import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  markDeletedOnServer, clearDeletedOnServer, isDeletedOnServer, listDeletedOnServer, failedLoadView,
} from './deletedOnServer'
import { listDeclinedDownloads, declineDownload } from './declinedDownloads'
import { applyV2MergeMap } from './v2Merge'

vi.mock('./offlineDb', () => ({ rekeyCachedUserBooks: async () => {} }))
vi.mock('./v2', () => ({ onV2: async () => false }))

beforeEach(() => (AsyncStorage as unknown as { __reset(): void }).__reset())

describe('deletedOnServer (#1174)', () => {
  it('mark_ThenClear_RoundTrips', async () => {
    await markDeletedOnServer('b1')
    await markDeletedOnServer('b1')
    await markDeletedOnServer('b2')
    expect(await isDeletedOnServer('b1')).toBe(true)
    expect([...(await listDeletedOnServer())].sort()).toEqual(['b1', 'b2'])
    await clearDeletedOnServer(['x', 'b1', 'b2'])
    expect(await listDeletedOnServer()).toEqual(new Set())
  })

  it('corruptStore_ReadsAsEmpty', async () => {
    await AsyncStorage.setItem('offline:deletedOnServer', '{nope')
    expect(await isDeletedOnServer('b1')).toBe(false)
  })

  it('separateFromDeclined', async () => {
    await markDeletedOnServer('b1')
    await declineDownload('b2')
    expect(await listDeclinedDownloads()).toEqual(new Set(['b2']))
    expect(await listDeletedOnServer()).toEqual(new Set(['b1']))
  })

  it('v2Merge_RekeysGuestIds', async () => {
    await markDeletedOnServer('guest-b')
    await markDeletedOnServer('other')
    await applyV2MergeMap({ books: { 'guest-b': 'acct-b' }, files: {} })
    expect([...(await listDeletedOnServer())].sort()).toEqual(['acct-b', 'other'])
  })
})

describe('failedLoadView', () => {
  const v = (o: Partial<Parameters<typeof failedLoadView>[0]>) =>
    failedLoadView({ notFound: false, tombstoned: false, hasCopy: false, offline: false, ...o })

  it('404_IsNotFound_EvenWithACopy', () => expect(v({ notFound: true, hasCopy: true })).toBe('notfound'))
  it('offlineAfterA404_IsNotFound_NotTheCachedCopy', () => expect(v({ tombstoned: true, hasCopy: true, offline: true })).toBe('notfound'))
  it('offlineWithCopy_IsCached', () => expect(v({ hasCopy: true, offline: true })).toBe('cached'))
  it('offlineNoCopy_IsOffline', () => expect(v({ offline: true })).toBe('offline'))
  it('otherError_IsFailed', () => expect(v({})).toBe('failed'))
})

/** Source guards: the screens cannot be mounted here (same approach as v2DefectsWiring.test). */
describe('#1174 wiring', () => {
  const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')
  const page = read('app/my-books/[id].tsx')

  it('both 404 branches mark the book; a successful load clears it', () => {
    expect(page.match(/await markDeletedOnServer\(id\)/g)).toHaveLength(2)
    expect(page).toMatch(/setOfflineMode\(false\)\s*\/\/[^\n]*\n\s*clearDeletedOnServer\(\[id\]\)/)
  })

  it('a failed load for a tombstoned book skips the cached copy', () => {
    expect(page).toContain('const tombstoned = !notFound && await isDeletedOnServer(id)')
    expect(page).toContain('notFound || tombstoned ? null : await rehydrateFromCache(id)')
  })

  it('not-found Remove and both 404 paths use the any-rows check, not the fully-cached one', () => {
    expect(page.match(/await hasAnyUserBookCache\(id\)/g)).toHaveLength(2)
    expect(page).toContain("secondaryLabel={loadError === 'notfound' && anyLocalCopy ?")
  })

  it('library: offline fallback filters tombstones; the online list clears them', () => {
    const lib = read('app/(tabs)/library.tsx')
    expect(lib).toContain('.filter(b => !deleted.has(b.id)))')
    expect(lib).toContain('clearDeletedOnServer(books.map(b => b.id))')
  })

  it('removing the download clears the mark', () => {
    const ctx = read('src/context/DownloadContext.tsx')
    const start = ctx.indexOf('const removeUserBookDownload')
    expect(ctx.slice(start, ctx.indexOf('}, [', start))).toContain('await clearDeletedOnServer([bookId])')
  })
})
