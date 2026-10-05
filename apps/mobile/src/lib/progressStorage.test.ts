import { describe, it, expect, beforeEach } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  saveLocalProgress,
  getLocalProgress,
  getAllLocalProgress,
  clearAllLocalProgress,
  saveUserBookLocalProgress,
  getAllUserBookLocalProgress,
  getUserBookLocalProgress,
  markLocalProgressSynced,
  markUserBookLocalProgressSynced,
  type LocalProgress,
} from './progressStorage'

/**
 * The offline half of reading progress. Every one of these cases is a way a
 * reader loses their place, which is the one failure this product cannot
 * afford — so they are pinned here rather than discovered on a plane.
 */

// `__reset` is test-only on the aliased mock.
const reset = () => (AsyncStorage as unknown as { __reset(): void }).__reset()

const progress = (o: Partial<LocalProgress> = {}): LocalProgress => ({
  chapterId: 'ch-1',
  chapterSlug: 'chapter-one',
  locator: 'scroll:chapter-one:1200',
  percent: 0.4,
  bookPercent: 0.12,
  updatedAt: 1_700_000_000_000,
  ...o,
})

beforeEach(reset)

describe('saveLocalProgress / getLocalProgress', () => {
  it('round-trips a record', async () => {
    await saveLocalProgress('ed-1', progress())
    expect(await getLocalProgress('ed-1')).toEqual(progress())
  })

  it('keeps the previous bookPercent when the caller omits it', async () => {
    // The regression: saves before the chapter list resolves — and EVERY save
    // while offline, where it never resolves — pass undefined. setItem writes
    // the whole record and JSON.stringify drops undefined, so the book-wide
    // percent was deleted and the resume card fell back to the CHAPTER percent,
    // announcing "85% complete" for a book 12% read.
    await saveLocalProgress('ed-1', progress({ bookPercent: 0.12 }))
    await saveLocalProgress('ed-1', progress({ bookPercent: undefined, percent: 0.85 }))

    const stored = await getLocalProgress('ed-1')
    expect(stored?.bookPercent).toBe(0.12)
    expect(stored?.percent).toBe(0.85)
  })

  it('survives repeated omissions rather than decaying after the first', async () => {
    await saveLocalProgress('ed-1', progress({ bookPercent: 0.3 }))
    for (let i = 0; i < 5; i++) {
      await saveLocalProgress('ed-1', progress({ bookPercent: undefined, updatedAt: 1_700_000_000_000 + i }))
    }
    expect((await getLocalProgress('ed-1'))?.bookPercent).toBe(0.3)
  })

  it('lets an explicit new bookPercent win', async () => {
    await saveLocalProgress('ed-1', progress({ bookPercent: 0.12 }))
    await saveLocalProgress('ed-1', progress({ bookPercent: 0.55 }))
    expect((await getLocalProgress('ed-1'))?.bookPercent).toBe(0.55)
  })

  it('accepts an empty chapterId — an offline-cached chapter has no server id', async () => {
    // Gating the save on a truthy chapterId is what made offline reading save
    // nothing at all; the record must still be written and readable.
    await saveLocalProgress('ed-1', progress({ chapterId: '' }))
    const stored = await getLocalProgress('ed-1')
    expect(stored).not.toBeNull()
    expect(stored?.chapterSlug).toBe('chapter-one')
  })

  it('returns null for an unknown edition', async () => {
    expect(await getLocalProgress('nope')).toBeNull()
  })

  it('returns null rather than throwing on a corrupt record', async () => {
    await AsyncStorage.setItem('textstack_progress_ed-1', '{not json')
    expect(await getLocalProgress('ed-1')).toBeNull()
  })
})

describe('getAllLocalProgress', () => {
  it('returns every catalog record keyed by edition id', async () => {
    await saveLocalProgress('ed-1', progress())
    await saveLocalProgress('ed-2', progress({ chapterSlug: 'two' }))
    const all = await getAllLocalProgress()
    expect([...all.keys()].sort()).toEqual(['ed-1', 'ed-2'])
  })

  it('excludes user-book rows, whose shape is different', async () => {
    // They share a key prefix by coincidence; mixing them would feed a
    // book-percent-only record into the catalog merge.
    await saveLocalProgress('ed-1', progress())
    await saveUserBookLocalProgress('ub-1', { bookPercent: 0.5, updatedAt: 1 })
    const all = await getAllLocalProgress()
    expect([...all.keys()]).toEqual(['ed-1'])
  })

  it('skips only the corrupt entry, not the whole map', async () => {
    await saveLocalProgress('ed-1', progress())
    await AsyncStorage.setItem('textstack_progress_ed-broken', 'garbage')
    const all = await getAllLocalProgress()
    expect([...all.keys()]).toEqual(['ed-1'])
  })

  it('is empty on a fresh install', async () => {
    expect((await getAllLocalProgress()).size).toBe(0)
  })
})

describe('getAllUserBookLocalProgress', () => {
  it('returns only user-book rows', async () => {
    await saveUserBookLocalProgress('ub-1', { bookPercent: 0.5, updatedAt: 1 })
    await saveLocalProgress('ed-1', progress())
    const all = await getAllUserBookLocalProgress()
    expect([...all.keys()]).toEqual(['ub-1'])
    expect(all.get('ub-1')?.bookPercent).toBe(0.5)
  })
})

describe('clearAllLocalProgress', () => {
  it('removes both keyspaces on sign-out and leaves everything else alone', async () => {
    // Progress leaking across accounts on a shared device is a privacy bug,
    // not just a correctness one.
    await saveLocalProgress('ed-1', progress())
    await saveUserBookLocalProgress('ub-1', { bookPercent: 0.5, updatedAt: 1 })
    await AsyncStorage.setItem('textstack-theme', 'dark')

    await clearAllLocalProgress()

    expect((await getAllLocalProgress()).size).toBe(0)
    expect((await getAllUserBookLocalProgress()).size).toBe(0)
    expect(await AsyncStorage.getItem('textstack-theme')).toBe('dark')
  })
})

describe('markLocalProgressSynced / markUserBookLocalProgressSynced', () => {
  it('flags the acknowledged write', async () => {
    await saveLocalProgress('ed-1', progress({ updatedAt: 5 }))
    await markLocalProgressSynced('ed-1', 5)
    expect((await getLocalProgress('ed-1'))?.synced).toBe(true)
  })

  it('leaves a newer save unsynced (the ack was for an older write)', async () => {
    await saveLocalProgress('ed-1', progress({ updatedAt: 6 }))
    await markLocalProgressSynced('ed-1', 5)
    expect((await getLocalProgress('ed-1'))?.synced).toBeUndefined()
  })

  it('a new save clears the flag', async () => {
    await saveLocalProgress('ed-1', progress({ updatedAt: 5 }))
    await markLocalProgressSynced('ed-1', 5)
    await saveLocalProgress('ed-1', progress({ updatedAt: 6, bookPercent: undefined }))
    expect((await getLocalProgress('ed-1'))?.synced).toBeUndefined()
  })

  it('works for uploads and keeps the record intact', async () => {
    await saveUserBookLocalProgress('ub-1', { bookPercent: 0.4, updatedAt: 7, page: 12, chapterSlug: null })
    await markUserBookLocalProgressSynced('ub-1', 7)
    expect(await getUserBookLocalProgress('ub-1')).toEqual({ bookPercent: 0.4, updatedAt: 7, page: 12, chapterSlug: null, synced: true })
  })

  it('no record → no-op', async () => {
    await markUserBookLocalProgressSynced('missing', 1)
    expect(await getUserBookLocalProgress('missing')).toBeNull()
  })
})
