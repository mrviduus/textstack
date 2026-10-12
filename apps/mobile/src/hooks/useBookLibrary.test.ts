// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '../test/renderHook'

const api = vi.hoisted(() => ({ getLibrary: vi.fn(), addToLibrary: vi.fn(), removeFromLibrary: vi.fn() }))
const collections = vi.hoisted(() => ({ listCollections: vi.fn(async () => []), getCollectionBookIds: vi.fn() }))
vi.mock('@textstack/shared', () => ({ libraryApi: api, collectionsApi: collections }))
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }))
vi.mock('./useCollections', () => ({ invalidateCollectionsCache: vi.fn() }))

import { useBookLibrary } from './useBookLibrary'

const render = () => renderHook(({ id }: { id: string }) => useBookLibrary(id, k => k), { id: 'b1' })
const deferred = () => { let resolve!: () => void, reject!: (e: Error) => void; const promise = new Promise<void>((s, j) => { resolve = s; reject = j }); return { promise, resolve, reject } }

describe('useBookLibrary', () => {
  beforeEach(() => { vi.clearAllMocks(); api.getLibrary.mockResolvedValue([]) })

  it('toggle_AddFails_RollsBackAndRereadsServer', async () => {
    api.addToLibrary.mockRejectedValue(new Error('500'))
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    const { result } = render()

    await act(async () => { await result.current.toggle() })

    expect(api.addToLibrary).toHaveBeenCalledWith('b1')
    expect(api.getLibrary).toHaveBeenCalledTimes(1)
    expect(result.current.inLibrary).toBe(true) // the server's answer, not the failed add
  })

  it('loadLibrary_AddInFlight_AsksServerOnlyAfterAddSettles', async () => {
    const add = deferred(); api.addToLibrary.mockReturnValue(add.promise)
    const { result } = render()
    act(() => result.current.saveIfNotSaved())

    let loaded!: Promise<void>
    act(() => { loaded = result.current.loadLibrary() })
    await act(async () => { await Promise.resolve() })
    expect(api.getLibrary).not.toHaveBeenCalled()

    await act(async () => { add.resolve(); await loaded })
    expect(api.getLibrary).toHaveBeenCalledTimes(1)
  })

  it('toggle_RemoveWhileDownloadAddFails_SkipsDelete', async () => {
    const add = deferred(); api.addToLibrary.mockReturnValue(add.promise)
    const { result } = render()
    act(() => result.current.saveIfNotSaved())
    expect(result.current.inLibrary).toBe(true)

    let toggled!: Promise<unknown>
    act(() => { toggled = result.current.toggle() })
    await act(async () => { add.reject(new Error('offline')); await toggled })

    expect(api.removeFromLibrary).not.toHaveBeenCalled()
  })

  it('saveIfNotSaved_AlreadySaved_DoesNotAdd', async () => {
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    const { result } = render()
    await act(async () => { await result.current.loadLibrary() })

    act(() => result.current.saveIfNotSaved())

    expect(api.addToLibrary).not.toHaveBeenCalled()
  })
})
