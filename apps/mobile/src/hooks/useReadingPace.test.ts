// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { FALLBACK_WPM } from '@textstack/shared'
import { renderHook } from '../test/renderHook'

// #1262: the V2 reader shows no time left until the pace call has answered; the legacy reader keeps its fallback.

const getReadingPace = vi.fn()
vi.mock('@textstack/shared', async (original) => ({
  ...(await original<typeof import('@textstack/shared')>()),
  readingTrackingApi: { getReadingPace: () => getReadingPace() },
}))

/** A fresh module per test: the pace is cached at module level. */
const hooks = () => import('./useReadingPace')
const mount = <R,>(hook: (enabled: boolean) => R, enabled: boolean) => renderHook(() => hook(enabled), {})
const settle = () => act(async () => {})

describe('useFetchedReadingPace', () => {
  beforeEach(() => {
    vi.resetModules()
    getReadingPace.mockReset()
  })

  it('notAnsweredYet_Null_ThenThePace', async () => {
    let answer!: (p: { wpm: number }) => void
    getReadingPace.mockReturnValue(new Promise((r) => { answer = r }))
    const h = mount((await hooks()).useFetchedReadingPace, true)
    expect(h.result.current).toBeNull()
    await act(async () => { answer({ wpm: 240 }) })
    expect(h.result.current).toBe(240)
    h.unmount()
  })

  it('callFailed_StaysNull', async () => {
    getReadingPace.mockRejectedValue(new Error('offline'))
    const h = mount((await hooks()).useFetchedReadingPace, true)
    await settle()
    expect(h.result.current).toBeNull()
    h.unmount()
  })

  it('unusablePace_StaysNull', async () => {
    getReadingPace.mockResolvedValue({ wpm: 0 })
    const h = mount((await hooks()).useFetchedReadingPace, true)
    await settle()
    expect(h.result.current).toBeNull()
    h.unmount()
  })

  it('answeredOnce_CachedForTheNextMount_NoSecondCall', async () => {
    getReadingPace.mockResolvedValue({ wpm: 240 })
    const { useFetchedReadingPace } = await hooks()
    const first = mount(useFetchedReadingPace, true)
    await settle()
    first.unmount()
    const second = mount(useFetchedReadingPace, true)
    expect(second.result.current).toBe(240)
    expect(getReadingPace).toHaveBeenCalledTimes(1)
    second.unmount()
  })

  it('notEnabled_NoCall', async () => {
    const h = mount((await hooks()).useFetchedReadingPace, false)
    await settle()
    expect(getReadingPace).not.toHaveBeenCalled()
    expect(h.result.current).toBeNull()
    h.unmount()
  })
})

describe('useReadingPace', () => {
  beforeEach(() => {
    vi.resetModules()
    getReadingPace.mockReset()
  })

  it('notAnsweredYet_TheFallbackPace_ThenThePace', async () => {
    let answer!: (p: { wpm: number }) => void
    getReadingPace.mockReturnValue(new Promise((r) => { answer = r }))
    const h = mount((await hooks()).useReadingPace, true)
    expect(h.result.current).toBe(FALLBACK_WPM)
    await act(async () => { answer({ wpm: 240 }) })
    expect(h.result.current).toBe(240)
    h.unmount()
  })
})
