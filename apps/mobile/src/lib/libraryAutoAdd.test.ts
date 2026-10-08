import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createLibraryAutoAdd, type AutoAddDeps } from './libraryAutoAdd'
import { markLibraryRemoved, clearLibraryRemoved, wasLibraryRemoved } from './libraryRemovals'

function deps(o: Partial<AutoAddDeps> = {}): AutoAddDeps {
  return {
    wasRemoved: vi.fn(async () => false),
    isInLibrary: vi.fn(async () => false),
    add: vi.fn(async () => {}),
    ...o,
  }
}

describe('createLibraryAutoAdd — web parity (useReaderLibraryTracking: 1% in)', () => {
  it('adds once the reader is 1% in, not before, not with an unknown percent', async () => {
    const d = deps()
    const maybeAdd = createLibraryAutoAdd(d)
    await maybeAdd('ed-1', 0.009)
    await maybeAdd('ed-1', null)
    expect(d.add).not.toHaveBeenCalled()
    await maybeAdd('ed-1', 0.01)
    expect(d.add).toHaveBeenCalledWith('ed-1')
  })

  it('asks once per book per app session — a chapter remount does not POST again', async () => {
    const d = deps()
    const maybeAdd = createLibraryAutoAdd(d)
    await maybeAdd('ed-1', 0.2)
    await maybeAdd('ed-1', 0.3)
    expect(d.isInLibrary).toHaveBeenCalledTimes(1)
    expect(d.add).toHaveBeenCalledTimes(1)
  })

  it('does not POST a book already in the library', async () => {
    const d = deps({ isInLibrary: vi.fn(async () => true) })
    await createLibraryAutoAdd(d)('ed-1', 0.5)
    expect(d.add).not.toHaveBeenCalled()
  })

  it('never re-adds a book the reader removed', async () => {
    const d = deps({ wasRemoved: vi.fn(async () => true) })
    await createLibraryAutoAdd(d)('ed-1', 0.5)
    expect(d.add).not.toHaveBeenCalled()
  })

  it('a failed add is retried on the next save', async () => {
    const add = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const d = deps({ add })
    const maybeAdd = createLibraryAutoAdd(d)
    await maybeAdd('ed-1', 0.5)
    await maybeAdd('ed-1', 0.5)
    expect(add).toHaveBeenCalledTimes(2)
  })

  it('is wired into the catalog reader save, behind the session check', () => {
    const src = readFileSync(resolve(__dirname, '../components/reader/useEditionReaderSource.ts'), 'utf8')
    const persist = src.slice(src.indexOf('const persist = useCallback('), src.indexOf('}, [isAuthenticated])'))
    const session = persist.indexOf('if (!isAuthenticated) return')
    expect(session).toBeGreaterThan(-1)
    expect(persist.indexOf('autoAddToLibrary(id, snap.bookPercent)')).toBeGreaterThan(session)
  })
})

describe('libraryRemovals — a removal is remembered on the device', () => {
  beforeEach(async () => { await AsyncStorage.clear() })

  it('remembers a removal until the reader adds the book back', async () => {
    expect(await wasLibraryRemoved('ed-1')).toBe(false)
    await markLibraryRemoved('ed-1')
    expect(await wasLibraryRemoved('ed-1')).toBe(true)
    await clearLibraryRemoved('ed-1')
    expect(await wasLibraryRemoved('ed-1')).toBe(false)
  })
})
