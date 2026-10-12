// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '../test/renderHook'

const api = vi.hoisted(() => ({ getLibrary: vi.fn(), addToLibrary: vi.fn(), removeFromLibrary: vi.fn() }))
const collections = vi.hoisted(() => ({ listCollections: vi.fn(async () => []), getCollectionBookIds: vi.fn() }))
const ApiError = vi.hoisted(() => class ApiError extends Error { constructor(public status: number) { super(String(status)) } })
vi.mock('@textstack/shared', () => ({ libraryApi: api, collectionsApi: collections, ApiError }))
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }))
vi.mock('./useCollections', () => ({ invalidateCollectionsCache: vi.fn() }))

import { useBookLibrary } from './useBookLibrary'

const render = (props: { id: string | undefined } = { id: 'b1' }) => renderHook(({ id }: { id: string | undefined }) => useBookLibrary(id, k => k), props)
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
const deferred = () => { let resolve!: () => void, reject!: (e: Error) => void; const promise = new Promise<void>((s, j) => { resolve = s; reject = j }); return { promise, resolve, reject } }

describe('useBookLibrary', () => {
  beforeEach(() => { vi.clearAllMocks(); api.getLibrary.mockResolvedValue([]); collections.listCollections.mockResolvedValue([]) })
  afterEach(() => { if (vi.isMockFunction(Date.now)) vi.mocked(Date.now).mockRestore() })

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

  it('addToLibrary_StaleGetAnswersBeforePostSucceeds_EndsSaved', async () => {
    // Device run: a GET sent before the POST answered "not in library"; the write's success is the last word.
    const get = deferred(); api.getLibrary.mockReturnValue(get.promise.then(() => []))
    const add = deferred(); api.addToLibrary.mockReturnValue(add.promise)
    const { result } = render()
    let loaded!: Promise<void>
    act(() => { loaded = result.current.loadLibrary() })
    await act(async () => { await Promise.resolve() })
    act(() => result.current.saveIfNotSaved())

    await act(async () => { get.resolve(); await loaded })
    expect(result.current.inLibrary).toBe(true) // the stale "not saved" is dropped, no flicker
    await act(async () => { add.resolve(); await add.promise })

    expect(result.current.inLibrary).toBe(true)
  })

  it('toggle_SavedBookInCollections_AsksBeforeRemoving', async () => {
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    collections.listCollections.mockResolvedValue([{ id: 'c1', count: 1 }] as never)
    collections.getCollectionBookIds.mockResolvedValue(['b1'] as never)
    const { Alert } = await import('react-native')
    const { result } = render()
    await act(async () => { await result.current.loadLibrary() })

    await act(async () => { await result.current.toggle() })

    expect(Alert.alert).toHaveBeenCalledTimes(1)
    expect(api.removeFromLibrary).not.toHaveBeenCalled()
  })

  it('loadLibrary_CancelledBeforeAnswer_KeepsState', async () => {
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    const { result } = render()

    await act(async () => { await result.current.loadLibrary(() => true) })

    expect(result.current.inLibrary).toBe(false)
  })

  it('saveIfNotSaved_AlreadySaved_DoesNotAdd', async () => {
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    const { result } = render()
    await act(async () => { await result.current.loadLibrary() })

    act(() => result.current.saveIfNotSaved())

    expect(api.addToLibrary).not.toHaveBeenCalled()
  })

  it('toggle_DoubleTap_SendsOnePost', async () => {
    const add = deferred(); api.addToLibrary.mockReturnValue(add.promise)
    const { result } = render()
    act(() => { void result.current.toggle(); void result.current.toggle() })
    await flush()
    expect(api.addToLibrary).toHaveBeenCalledTimes(1)
    add.resolve()
    await flush()
    expect(api.removeFromLibrary, 'the second tap is the same tap, not a remove').not.toHaveBeenCalled()
    expect(result.current.inLibrary).toBe(true)
  })

  it('toggle_TapAfterAddSettles_Removes', async () => {
    api.addToLibrary.mockResolvedValue(undefined)
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const { result } = render()
    await act(async () => { await result.current.toggle() })
    now.mockReturnValue(11_000)
    await act(async () => { await result.current.toggle() })
    await flush()
    expect(api.removeFromLibrary).toHaveBeenCalledTimes(1)
  })

  it('saveIfNotSaved_DeleteInFlight_PostWaitsForDelete', async () => {
    // Review r9: Download tapped during a confirmed Remove raced the DELETE.
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    const del = deferred(); api.removeFromLibrary.mockReturnValue(del.promise)
    const add = deferred(); api.addToLibrary.mockReturnValue(add.promise)
    const { result } = render()
    await act(async () => { await result.current.loadLibrary() })
    act(() => { void result.current.toggle() })
    await flush()
    expect(api.removeFromLibrary).toHaveBeenCalledTimes(1)

    act(() => result.current.saveIfNotSaved())
    await flush()
    expect(api.addToLibrary).not.toHaveBeenCalled()

    del.resolve()
    await flush()
    expect(api.addToLibrary).toHaveBeenCalledTimes(1)
    expect(result.current.inLibrary, 'the DELETE answering never flips back to "Save"').toBe(true)
    add.resolve()
    await flush()
    expect(result.current.inLibrary).toBe(true)
  })

  it('loadLibrary_DeleteInFlight_AsksServerOnlyAfterDeleteSettles', async () => {
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    const del = deferred(); api.removeFromLibrary.mockReturnValue(del.promise)
    const { result } = render()
    await act(async () => { await result.current.loadLibrary() })
    act(() => { void result.current.toggle() })
    await flush()
    api.getLibrary.mockClear()

    act(() => { void result.current.loadLibrary() })
    await flush()
    expect(api.getLibrary).not.toHaveBeenCalled()
    del.resolve()
    await flush()
    expect(api.getLibrary).toHaveBeenCalledTimes(1)
  })

  it('toggle_RemoveAfterAddPostAnswers_NeverFlipsBackToSaved', async () => {
    const add = deferred(); api.addToLibrary.mockReturnValue(add.promise)
    const del = deferred(); api.removeFromLibrary.mockReturnValue(del.promise)
    const { result } = render()
    act(() => result.current.saveIfNotSaved())
    act(() => { void result.current.toggle() })
    await act(async () => { add.resolve() })
    await flush()
    expect(api.removeFromLibrary).toHaveBeenCalledTimes(1)
    expect(result.current.inLibrary).toBe(false)
    await act(async () => { del.resolve() })
    expect(result.current.inLibrary).toBe(false)
  })

  it('toggle_Remove404_EndsRemoved', async () => {
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    api.removeFromLibrary.mockRejectedValue(new ApiError(404))
    const { result } = render()
    await act(async () => { await result.current.loadLibrary() })
    await act(async () => { await result.current.toggle() })
    await flush()
    expect(result.current.inLibrary).toBe(false)
  })

  it('toggle_RemoveFails_RollsBack', async () => {
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    api.removeFromLibrary.mockRejectedValue(new ApiError(500))
    const { result } = render()
    await act(async () => { await result.current.loadLibrary() })
    await act(async () => { await result.current.toggle() })
    await flush()
    expect(result.current.inLibrary).toBe(true)
  })

  it('loadLibrary_BookIdChangesBeforeAnswer_DropsAnswer', async () => {
    let answer!: (v: { editionId: string }[]) => void
    api.getLibrary.mockReturnValue(new Promise(r => { answer = r }))
    const { result, rerender } = render()
    act(() => { void result.current.loadLibrary() })
    await flush()
    rerender({ id: 'b2' })
    answer([{ editionId: 'b1' }])
    await flush()
    expect(result.current.inLibrary).toBe(false)
  })

  it('useBookLibrary_BookIdChanges_ShowsNotSaved', async () => {
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    const { result, rerender } = render()
    await act(async () => { await result.current.loadLibrary() })
    expect(result.current.inLibrary).toBe(true)
    rerender({ id: 'b2' })
    expect(result.current.inLibrary).toBe(false)
  })

  it('loadLibraryToggleSave_NoBookId_SendNothing', async () => {
    const { result } = render({ id: undefined })
    await act(async () => { await result.current.loadLibrary(); await result.current.toggle(); result.current.saveIfNotSaved() })
    expect(api.getLibrary).not.toHaveBeenCalled()
    expect(api.addToLibrary).not.toHaveBeenCalled()
  })

  it('toggle_GetHangs_PostStillSent', async () => {
    // Review #787: a page-open getLibrary that never answers must not hold the Save.
    api.getLibrary.mockReturnValue(new Promise(() => {}))
    api.addToLibrary.mockResolvedValue(undefined)
    const { result } = render()
    act(() => { void result.current.loadLibrary() })
    await flush()
    act(() => { void result.current.toggle() })
    await flush()
    expect(api.addToLibrary).toHaveBeenCalledWith('b1')
  })

  it('loadLibrary_AnswerArrivesAfterWriteSettles_IsDropped', async () => {
    const get = deferred(); api.getLibrary.mockReturnValue(get.promise.then(() => []))
    api.addToLibrary.mockResolvedValue(undefined)
    const { result } = render()
    act(() => { void result.current.loadLibrary() })
    await flush()
    act(() => result.current.saveIfNotSaved())
    await flush()
    await act(async () => { get.resolve() })
    await flush()
    expect(result.current.inLibrary).toBe(true)
  })

  it('toggle_SlowAddSecondTapLater_Removes', async () => {
    // Review #787: only a double tap is absorbed, not every tap until the POST answers.
    const add = deferred(); api.addToLibrary.mockReturnValue(add.promise)
    api.removeFromLibrary.mockResolvedValue(undefined)
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const { result } = render()
    act(() => { void result.current.toggle() })
    now.mockReturnValue(12_000)
    act(() => { void result.current.toggle() })
    await act(async () => { add.resolve() })
    await flush()
    expect(api.removeFromLibrary).toHaveBeenCalledTimes(1)
    expect(result.current.inLibrary).toBe(false)
  })

  it('saveIfNotSaved_DuringRemoveLookup_KeepsBook', async () => {
    // Review #787: a Download is intent — one tapped while the Remove looks up collections cancels it.
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    const lookup = deferred(); collections.listCollections.mockReturnValue(lookup.promise.then(() => []) as never)
    const { result } = render()
    await act(async () => { await result.current.loadLibrary() })
    act(() => { void result.current.toggle() })
    await flush()
    act(() => result.current.saveIfNotSaved())
    await act(async () => { lookup.resolve() })
    await flush()
    expect(api.removeFromLibrary).not.toHaveBeenCalled()
    expect(result.current.inLibrary).toBe(true)
  })

  it('useBookLibrary_BookIdChanges_FirstFrameIsNotSaved', async () => {
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    const seen: boolean[] = []
    const { result, rerender } = renderHook(({ id }: { id: string }) => {
      const r = useBookLibrary(id, k => k); seen.push(r.inLibrary); return r
    }, { id: 'b1' })
    await act(async () => { await result.current.loadLibrary() })
    seen.length = 0
    rerender({ id: 'b2' })
    expect(seen[0]).toBe(false)
  })

  it('loadLibrary_WriteQueuedWhileWaiting_SkipsFetch', async () => {
    // Review #787: an answer certain to be dropped is not fetched.
    api.getLibrary.mockResolvedValue([{ editionId: 'b1' }])
    const del = deferred(); api.removeFromLibrary.mockReturnValue(del.promise)
    const add = deferred(); api.addToLibrary.mockReturnValue(add.promise)
    const { result } = render()
    await act(async () => { await result.current.loadLibrary() })
    act(() => { void result.current.toggle() })
    await flush()
    api.getLibrary.mockClear()
    act(() => { void result.current.loadLibrary() })
    act(() => result.current.saveIfNotSaved())
    await act(async () => { del.resolve() })
    await flush()
    await act(async () => { add.resolve() })
    await flush()
    expect(api.getLibrary).not.toHaveBeenCalled()
    expect(result.current.inLibrary).toBe(true)
  })
})
