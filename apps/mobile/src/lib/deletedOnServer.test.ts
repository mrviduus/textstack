import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  markDeletedOnServer, clearDeletedOnServer, isDeletedOnServer, listDeletedOnServer, failedLoadView,
} from './deletedOnServer'
import { listDeclinedDownloads, declineDownload, updateIdSet } from './declinedDownloads'
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
  // Online, a 500 / 401 for a tombstoned book is not evidence either way: Retry, not "deleted", not the copy.
  it('onlineFailureAfterA404_IsFailed_NotTheCachedCopy', () => expect(v({ tombstoned: true, hasCopy: true })).toBe('failed'))
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

  it('not-found Remove and both 404 paths use the leftovers check (rows or original), not the fully-cached one', () => {
    expect(page.match(/await hasLocalLeftovers\(id\)/g)).toHaveLength(2)
    expect(page).toMatch(/async function hasLocalLeftovers[\s\S]*?hasAnyUserBookCache\(bookId\)[\s\S]*?listStoredOriginalIds\(\)[\s\S]*?return rows \|\| originals\.has\(bookId\)/)
    expect(page).toContain("secondaryLabel={loadError === 'notfound' && anyLocalCopy ?")
  })

  it('rows changing behind the screen refresh the leftovers answer too', () => {
    expect(page).toContain('hasLocalLeftovers(id).then(c => { if (!unmountedRef.current) setAnyLocalCopy(c) })')
  })

  it('load effect: a superseded run writes nothing and does not mark', () => {
    expect(page).toContain('const live = () => !stale && !unmountedRef.current')
    expect(page).toContain('return () => { stale = true }')
    expect(page).toMatch(/if \(!live\(\)\) return\s*if \(notFound\) await markDeletedOnServer\(id\)/)
    const start = page.indexOf('let stale = false')
    const body = page.slice(start, page.indexOf('return () => { stale = true }', start))
    expect(body).not.toContain('unmountedRef.current) return')
    expect(body).toContain('if (live()) setLoading(false)')
  })

  it('library: the offline fallback keeps a tombstoned book listed (its screen offers Remove); no online clear', () => {
    const lib = read('app/(tabs)/library.tsx')
    expect(lib).not.toContain('deletedOnServer')
  })

  it('removing the download clears the mark', () => {
    const ctx = read('src/context/DownloadContext.tsx')
    const start = ctx.indexOf('const removeUserBookDownload')
    expect(ctx.slice(start, ctx.indexOf('}, [', start))).toContain('await clearDeletedOnServer([bookId])')
  })

  it('the orphan sweep clears the mark of what it removed', () => {
    const ctx = read('src/context/DownloadContext.tsx')
    expect(ctx).toMatch(/await undeclineDownload\(id\)\s*\/\/[^\n]*\n\s*await clearDeletedOnServer\(\[id\]\)/)
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

/** Regression guards (QA #1174): `updateIdSet` serialises read-modify-write per key, so overlapping
 *  mark / clear calls both apply. */
describe('#1174 QA — concurrent updates (serialisation guards)', () => {
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

  it('updateIdSet_ThrowingChange_RejectsItselfOnly', async () => {
    const failed = updateIdSet('offline:deletedOnServer', () => { throw new Error('boom') })
    const next = markDeletedOnServer('b')
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBeUndefined()
    expect(await listDeletedOnServer()).toEqual(new Set(['b']))
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

  it('the failed-load view alone drives the screen: one switch, no second branch on the copy', () => {
    expect(page).toContain('switch (view) {')
    expect(page).toContain("case 'cached':")
    expect(page).toMatch(/case 'offline':\s*case 'failed':\s*setLoadError\(view\)/)
    expect(page).not.toContain('else if (rehydrated)')
  })

  it('both 404 paths store the leftovers answer, after a stale/cancel guard', () => {
    expect(page.match(/setAnyLocalCopy\(onDevice\)/g)).toHaveLength(2)
    expect(page).toMatch(/case 'notfound': \{\s*const onDevice = await hasLocalLeftovers\(id\)\s*if \(!live\(\)\) return/)
    expect(page).toMatch(/await markDeletedOnServer\(id\)\s*const onDevice = await hasLocalLeftovers\(id\)\s*if \(cancelled \|\| unmountedRef\.current\) return/)
  })

  it('the not-found copy and Remove key on anyLocalCopy; Remove resets it', () => {
    expect(page).toContain("? (anyLocalCopy ? t('myBooks.deleted.body') : t('myBooks.deleted.bodyNoCopy'))")
    expect(page).toContain('setCached(false); setAnyLocalCopy(false); router.back()')
  })

})
