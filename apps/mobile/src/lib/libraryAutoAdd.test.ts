import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createLibraryAutoAdd, type AutoAddDeps } from './libraryAutoAdd'
import { markLibraryRemoved, clearLibraryRemoved, wasLibraryRemoved } from './libraryRemovals'

function deps(o: Partial<AutoAddDeps> = {}): AutoAddDeps {
  return {
    wasRemoved: vi.fn(async () => false),
    isOnline: vi.fn(async () => true),
    add: vi.fn(async () => {}),
    ...o,
  }
}

describe('createLibraryAutoAdd — web parity (useReaderLibraryTracking: 1% in)', () => {
  it('adds once the reader is 1% in, not before, not with an unknown percent', async () => {
    const d = deps()
    const { maybeAdd } = createLibraryAutoAdd(d)
    await maybeAdd('u1', 'ed-1', 0.009)
    await maybeAdd('u1', 'ed-1', null)
    expect(d.add).not.toHaveBeenCalled()
    await maybeAdd('u1', 'ed-1', 0.01)
    expect(d.add).toHaveBeenCalledWith('ed-1')
  })

  it('one idempotent POST per book per account per session — no library download (review 2 #4)', async () => {
    const d = deps()
    const { maybeAdd } = createLibraryAutoAdd(d)
    await maybeAdd('u1', 'ed-1', 0.2)
    await maybeAdd('u1', 'ed-1', 0.3)
    expect(d.add).toHaveBeenCalledTimes(1)
    expect(d).not.toHaveProperty('isInLibrary')
  })

  it('is scoped to the account: another user on the same device is asked again (review 2 #1)', async () => {
    const d = deps()
    const { maybeAdd } = createLibraryAutoAdd(d)
    await maybeAdd('u1', 'ed-1', 0.2)
    await maybeAdd('u2', 'ed-1', 0.2)
    expect(d.add).toHaveBeenCalledTimes(2)
    expect(d.wasRemoved).toHaveBeenLastCalledWith('u2', 'ed-1')
  })

  it('never re-adds a book the reader removed', async () => {
    const d = deps({ wasRemoved: vi.fn(async () => true) })
    await createLibraryAutoAdd(d).maybeAdd('u1', 'ed-1', 0.5)
    expect(d.add).not.toHaveBeenCalled()
  })

  it('offline: does not even try (review 2 #3)', async () => {
    const d = deps({ isOnline: vi.fn(async () => false) })
    await createLibraryAutoAdd(d).maybeAdd('u1', 'ed-1', 0.5)
    expect(d.add).not.toHaveBeenCalled()
  })

  it('a failure is retried at most once per book per session — no storm on a 5xx (review 2 #3)', async () => {
    const add = vi.fn(async () => { throw new Error('500') })
    const { maybeAdd } = createLibraryAutoAdd(deps({ add }))
    for (let i = 0; i < 5; i++) await maybeAdd('u1', 'ed-1', 0.5)
    expect(add).toHaveBeenCalledTimes(2)
  })

  it('exposes the in-flight add so a screen can wait for it before reading the library', async () => {
    let release!: () => void
    const add = vi.fn(() => new Promise<void>(r => { release = r }))
    const { maybeAdd, settled } = createLibraryAutoAdd(deps({ add }))
    const p = maybeAdd('u1', 'ed-1', 0.5)
    let done = false
    const waiting = settled('u1', 'ed-1').then(() => { done = true })
    await vi.waitFor(() => expect(add).toHaveBeenCalled())
    expect(done).toBe(false)
    release()
    await p
    await waiting
    expect(done).toBe(true)
  })

  it('is wired into the catalog reader save, behind the session check', () => {
    const src = readFileSync(resolve(__dirname, '../components/reader/useEditionReaderSource.ts'), 'utf8')
    const persist = src.slice(src.indexOf('const persist = useCallback('), src.indexOf('const openedFromRef'))
    const session = persist.indexOf('if (!isAuthenticated) return')
    expect(session).toBeGreaterThan(-1)
    expect(persist.indexOf('autoAddToLibrary(')).toBeGreaterThan(session)
  })
})

describe('libraryRemovals — a removal is remembered per account (review 2 #1)', () => {
  beforeEach(async () => { await AsyncStorage.clear() })

  it('remembers a removal until the reader adds the book back', async () => {
    expect(await wasLibraryRemoved('u1', 'ed-1')).toBe(false)
    await markLibraryRemoved('u1', 'ed-1')
    expect(await wasLibraryRemoved('u1', 'ed-1')).toBe(true)
    await clearLibraryRemoved('u1', 'ed-1')
    expect(await wasLibraryRemoved('u1', 'ed-1')).toBe(false)
  })

  it('one account removing a book says nothing about another account', async () => {
    await markLibraryRemoved('u1', 'ed-1')
    expect(await wasLibraryRemoved('u2', 'ed-1')).toBe(false)
  })
})
