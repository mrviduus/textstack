import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  markDeletedOnServer, clearDeletedOnServer, isDeletedOnServer, listDeletedOnServer, failedLoadView, forgetDeletedOnServer,
  deletedStillOnDevice, chooseNewlyDeleted,
} from './deletedOnServer'
import { listDeclinedDownloads, declineDownload, updateIdSet, forgetDeclinedDownloads } from './declinedDownloads'
import { applyMergeMap } from './merge'

vi.mock('./sync', () => ({ syncOn: async () => false }))

beforeEach(() => (AsyncStorage as unknown as { __reset(): void }).__reset())

describe('deletedStillOnDevice (#1193)', () => {
  it('deletedStillOnDevice_MarkedAndOnDevice_Listed', () => {
    expect(deletedStillOnDevice(new Set(['a', 'b']), ['a', 'x'], new Set())).toEqual(['a'])
  })

  it('deletedStillOnDevice_RowsAndOriginalBothLocal_CountedOnce', () => {
    expect(deletedStillOnDevice(new Set(['a']), ['a', 'a'], new Set())).toEqual(['a'])
  })

  it('deletedStillOnDevice_MarkedButNothingLocal_Empty', () => {
    expect(deletedStillOnDevice(new Set(['a']), ['x'], new Set())).toEqual([])
  })

  it('deletedStillOnDevice_MarkedButListedByLibrary_Excluded', () => {
    expect(deletedStillOnDevice(new Set(['a', 'b']), ['a', 'b'], new Set(['a']))).toEqual(['b'])
  })
})

describe('chooseNewlyDeleted (#1193)', () => {
  const local = new Map([['v2-gone', 'v2'], ['legacy-gone', 'legacy'], ['orig-only', 'unknown'], ['live', 'legacy']] as const)

  it('chooseNewlyDeleted_LegacyListing_MarksOnlyLegacyCopies', () => {
    // Probe off/unreached: the legacy list lacks every V2-only book; those must not be marked.
    expect(chooseNewlyDeleted({ local, listed: new Set(['live']), from: 'legacy', marked: new Set() })).toEqual(['legacy-gone'])
  })

  it('chooseNewlyDeleted_V2Listing_MarksOnlyV2Copies', () => {
    expect(chooseNewlyDeleted({ local, listed: new Set(['live']), from: 'v2', marked: new Set() })).toEqual(['v2-gone'])
  })

  it('chooseNewlyDeleted_SourceUnknown_MarksNothing', () => {
    expect(chooseNewlyDeleted({ local, listed: new Set(), from: null, marked: new Set() })).toEqual([])
  })

  it('chooseNewlyDeleted_AlreadyMarked_Skipped', () => {
    expect(chooseNewlyDeleted({ local, listed: new Set(['live']), from: 'legacy', marked: new Set(['legacy-gone']) })).toEqual([])
  })

  it('chooseNewlyDeleted_EmptyListing_MarksEveryCopyOfThatStore', () => {
    // An empty successful listing is a real answer; the caller never passes a failed one.
    expect(chooseNewlyDeleted({ local, listed: new Set(), from: 'legacy', marked: new Set() })).toEqual(['legacy-gone', 'live'])
  })
})

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

  it('isDeletedOnServer_QueuedBehindAPendingClear_ReadsTheCleared', async () => {
    await markDeletedOnServer('b1')
    const clearing = clearDeletedOnServer(['b1']) // not awaited: a success run's clear still in flight
    expect(await isDeletedOnServer('b1')).toBe(false)
    await clearing
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

  it('merge_RekeysGuestIds', async () => {
    await markDeletedOnServer('guest-b')
    await markDeletedOnServer('other')
    await applyMergeMap({ books: { 'guest-b': 'acct-b' }, files: {} })
    expect([...(await listDeletedOnServer())].sort()).toEqual(['acct-b', 'other'])
  })
})

describe('#1192 — sign-out forgets both id sets', () => {
  it('forget_BothSets_Empty_AndQueuedBehindAPendingMark', async () => {
    await declineDownload('d1')
    const marking = markDeletedOnServer('b1') // not awaited: the forget must not be overtaken by it
    await Promise.all([forgetDeclinedDownloads(), forgetDeletedOnServer(), marking])
    expect(await listDeclinedDownloads()).toEqual(new Set())
    expect(await listDeletedOnServer()).toEqual(new Set())
  })

  it('the sign-out wipe in DownloadContext calls both', () => {
    const ctx = readFileSync(resolve(__dirname, '../context/DownloadContext.tsx'), 'utf8')
    const wipe = ctx.slice(ctx.indexOf('if (wasAuthenticatedRef.current && !isAuthenticated) {'), ctx.indexOf('wasAuthenticatedRef.current = isAuthenticated'))
    expect(wipe).toContain('forgetDeclinedDownloads()')
    expect(wipe).toContain('forgetDeletedOnServer()')
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

/** Source guards: the screens cannot be mounted here (same approach as syncDefectsWiring.test). */
describe('#1174 wiring', () => {
  const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')
  const page = read('app/my-books/[id].tsx')

  it('a 404 marks the book only when something is on the device; a successful load clears it', () => {
    expect(page.match(/if \(onDevice\) await markDeletedOnServer\(id\)/g)).toHaveLength(1)
    expect(page.match(/markDeletedOnServer\(id\)/g)).toHaveLength(1)
    expect(page).toContain('const onDevice = notFound && await hasLocalLeftovers(id)')
    expect(page).toContain('clearDeletedOnServer([id])')
  })

  it('a failed load for a tombstoned book skips the cached copy', () => {
    expect(page).toContain('const tombstoned = !notFound && await isDeletedOnServer(id)')
    expect(page).toContain('notFound || tombstoned ? null : await rehydrateFromDevice(id)')
  })

  it('not-found Remove and the 404 path use the leftovers check', () => {
    expect(page.match(/await hasLocalLeftovers\(id\)/g)).toHaveLength(2)
    expect(page).toContain("import { hasLocalLeftovers } from '../../src/lib/localLeftovers'")
    expect(page).toContain("secondaryLabel={loadError === 'notfound' && anyLocalCopy ?")
  })

  it('load effect: a superseded run writes nothing and does not mark', () => {
    expect(page).toContain('const live = () => !stale && !unmountedRef.current')
    expect(page).toContain('return () => { stale = true }')
    expect(page).toMatch(/if \(!live\(\)\) return\s*if \(onDevice\) await markDeletedOnServer\(id\)/)
    const start = page.indexOf('let stale = false')
    const body = page.slice(start, page.indexOf('return () => { stale = true }', start))
    expect(body).not.toContain('unmountedRef.current) return')
    expect(body).toContain('if (live()) setLoading(false)')
  })

  it('library: offline, a tombstoned book is not listed (prev included); an online list clears marks', () => {
    const lib = read('app/(tabs)/library.tsx')
    expect(lib).toMatch(/const \[onDevice, localProgress, deleted\] = await Promise\.all\(\[[\s\S]*?listDeletedOnServer\(\),\s*\]\)/)
    // On the whole ternary, so a list loaded online earlier this session (`prev`) loses it too.
    expect(lib).toContain('}))).filter(b => !deleted.has(b.id)))')
    expect(lib).not.toContain("'Failed'")
    expect(lib).toMatch(/setUserBooks\(books\)[\s\S]*?clearDeletedOnServer\(books\.map\(b => b\.id\)\)[\s\S]*?\} catch \(e\)/)
  })

  it('removing the download clears the mark', () => {
    const ctx = read('src/context/DownloadContext.tsx')
    const start = ctx.indexOf('const removeUserBookDownloads')
    expect(ctx.slice(start, ctx.indexOf('}, [', start))).toContain('await clearDeletedOnServer([bookId])')
  })

  it('library: a successful load marks what it lacks, guarded by the epoch and the generation', () => {
    const lib = read('app/(tabs)/library.tsx')
    expect(lib).toContain('const books = await userBooksApi.getUserBooks()')
    expect(lib).toContain('const stale = () => syncEpoch() !== epoch || myGen !== loadGenRef.current')
    expect(lib).toContain("markUnlistedLeftovers(new Set(books.map(b => b.id)), 'v2', stale)")
    expect(lib).toContain('if (ids.length > 0 && !stale()) setMarksVersion(v => v + 1)')
  })

  it('library: the deleted-books row sits under the list and in both empty states', () => {
    const lib = read('app/(tabs)/library.tsx')
    expect(lib).toContain('listFooter={<DeletedDownloadsRow listedIds={userBooks.map(b => b.id)} refreshKey={marksVersion} />}')
    expect(lib.match(/<DeletedDownloadsRow listedIds=\{\[\]\} refreshKey=\{marksVersion\} \/>/g)).toHaveLength(2)
    expect(read('src/components/library/BookList.tsx')).toContain('ListFooterComponent={listFooter ?')
  })

  it('the deleted-books row: one leftovers rule, re-read on focus, bulk non-declining remove', () => {
    const row = read('src/components/library/DeletedDownloadsRow.tsx')
    expect(row).toMatch(/useFocusEffect\(useCallback\(\(\) => \{\s*let cancelled = false\s*Promise\.all\(\[listDeletedOnServer\(\), listLocalLeftovers\(\)\]\)/)
    expect(row).toContain('}, [removed, listedKey, refreshKey]))')
    expect(row).toContain('Promise.all([listDeletedOnServer(), listLocalLeftovers()])')
    expect(row).toContain('deletedStillOnDevice(marked, local.keys(), new Set(listedIds))')
    expect(row).toContain('await removeUserBookDownloads(ids)')
    expect(row).toContain('if (failed > 0) {')
    expect(row).toContain('Alert.alert(')
    expect(row).toContain('onPress={confirm}')
    expect(row).toContain('accessibilityLabel=')
    // No visible words outside the catalogue.
    expect(row).not.toMatch(/'deleted books?'/)
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

  it('merge_NothingToRekey_DoesNotWrite', async () => {
    await markDeletedOnServer('other')
    const spy = setItem()
    await applyMergeMap({ books: { 'guest-b': 'acct-b' }, files: {} })
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
    expect(page).toMatch(/case 'notfound': \{\s*const leftovers = notFound \? onDevice : await hasLocalLeftovers\(id\)\s*if \(!live\(\)\) return/)
    expect(page).toContain('setAnyLocalCopy(leftovers)')
  })

  it('the not-found copy and Remove key on anyLocalCopy; Remove resets it', () => {
    expect(page).toContain("? (anyLocalCopy ? t('myBooks.deleted.body') : t('myBooks.deleted.bodyNoCopy'))")
    expect(page).toContain('.then(() => { setAnyLocalCopy(false); router.back() })')
  })

})
