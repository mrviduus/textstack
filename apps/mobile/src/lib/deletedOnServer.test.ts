import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

/** QA (#1174): kills mutants the tests above let through. */
describe('#1174 QA — id-set writes', () => {
  afterEach(() => vi.restoreAllMocks())
  const setItem = () => vi.spyOn(AsyncStorage, 'setItem')

  it('markDeletedOnServer_AlreadyMarked_DoesNotWrite', async () => {
    await markDeletedOnServer('b1')
    const spy = setItem()
    await markDeletedOnServer('b1')
    expect(spy).not.toHaveBeenCalled()
  })

  it('clearDeletedOnServer_NoneMarked_DoesNotWrite', async () => {
    await markDeletedOnServer('b1')
    const spy = setItem()
    await clearDeletedOnServer(['x', 'y'])
    expect(spy).not.toHaveBeenCalled()
  })

  it('v2Merge_NothingToRekey_DoesNotWrite', async () => {
    await markDeletedOnServer('other')
    const spy = setItem()
    await applyV2MergeMap({ books: { 'guest-b': 'acct-b' }, files: {} })
    expect(spy.mock.calls.filter(([k]) => k === 'offline:deletedOnServer')).toEqual([])
  })

  // The 404 branch awaits the mark inside `catch`: a rejection there would skip the not-found
  // screen and leave whatever the screen showed before (finally only clears the spinner).
  it('markDeletedOnServer_StorageWriteFails_ResolvesAndMarkIsLost', async () => {
    vi.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('disk full'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(markDeletedOnServer('b1')).resolves.toBeUndefined()
    // Degrades to pre-#1174: the next offline load shows the cached copy as live.
    expect(await isDeletedOnServer('b1')).toBe(false)
  })

  it('markDeletedOnServer_StorageReadFails_StillResolves', async () => {
    vi.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('io'))
    await expect(markDeletedOnServer('b1')).resolves.toBeUndefined()
    await expect(clearDeletedOnServer(['b1'])).resolves.toBeUndefined()
  })
})

/**
 * Known bug (QA #1174): read-modify-write with no serialisation. The library's online clear and the
 * book screen's fire-and-forget clear both run on reconnect, beside the 404 mark — one update is lost.
 */
describe('#1174 QA — concurrent updates (bug repros)', () => {
  it('concurrentMarkAndClear_BothApplied', async () => {
    await markDeletedOnServer('a')
    // Library lists `a` again (clears it) while the book screen marks `b` after a 404.
    await Promise.all([clearDeletedOnServer(['a']), markDeletedOnServer('b')])
    expect(await listDeletedOnServer()).toEqual(new Set(['b']))
  })

  it('concurrentMarks_BothKept', async () => {
    await Promise.all([markDeletedOnServer('a'), markDeletedOnServer('b')])
    expect(await listDeletedOnServer()).toEqual(new Set(['a', 'b']))
  })
})

describe('#1174 QA — web twin', () => {
  it('hasAnyUserBookCache_Web_IsFalse', async () => {
    const web = await import('./offlineDb.web')
    expect(await web.hasAnyUserBookCache()).toBe(false)
  })
})

describe('#1174 QA — wiring the first pass missed', () => {
  const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')
  const page = read('app/my-books/[id].tsx')

  it('the failed-load view drives the screen', () => {
    expect(page).toContain("if (view === 'notfound') {")
    expect(page).toContain("setLoadError(view === 'offline' ? 'offline' : 'failed')")
  })

  it('both 404 paths store the any-rows answer, after an unmount/cancel guard', () => {
    expect(page.match(/setAnyLocalCopy\(onDevice\)/g)).toHaveLength(2)
    expect(page).toMatch(/if \(view === 'notfound'\) \{\s*const onDevice = await hasAnyUserBookCache\(id\)\.catch\(\(\) => false\)\s*if \(unmountedRef\.current\) return/)
    expect(page).toMatch(/await markDeletedOnServer\(id\)\s*const onDevice = await hasAnyUserBookCache\(id\)\.catch\(\(\) => false\)\s*if \(cancelled \|\| unmountedRef\.current\) return/)
  })

  it('the not-found copy and Remove key on anyLocalCopy; Remove resets it', () => {
    expect(page).toContain("? (anyLocalCopy ? t('myBooks.deleted.body') : t('myBooks.deleted.bodyNoCopy'))")
    expect(page).toContain('setCached(false); setAnyLocalCopy(false); router.back()')
  })

  it('library: the offline fallback reads the tombstones and filters both halves', () => {
    const lib = read('app/(tabs)/library.tsx')
    expect(lib).toMatch(/const \[cached, cachedUploads, localProgress, deleted\] = await Promise\.all\(\[[\s\S]*?listDeletedOnServer\(\),\s*\]\)/)
    // On the whole ternary, so a stale online list (`prev`) loses a book marked since, too.
    expect(lib).toContain('}))).filter(b => !deleted.has(b.id)))\n')
  })
})
