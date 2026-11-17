// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { FALLBACK_WPM } from '@textstack/shared'
import { renderHook } from '../test/renderHook'
import { fakeApi } from '../../../../packages/shared/src/api/__tests__/fakeV2Api'

// #1262: the V2 reader shows no time left until the pace call has answered; the legacy reader keeps its fallback.

const getReadingPace = vi.fn()
vi.mock('@textstack/shared', async (original) => ({
  ...(await original<typeof import('@textstack/shared')>()),
  readingTrackingApi: { getReadingPace: () => getReadingPace() },
}))

// The real V2 gate (lib/readingTrackingApi → lib/v2); only its device IO is stubbed.
vi.mock('../lib/offlineDb', () => ({ dropReplacedUserBookFiles: async () => [] }))
vi.mock('../lib/originalFileCache', () => ({ deleteOriginal: async () => {} }))

/** A fresh module per test: the pace is cached at module level. */
const hooks = () => import('./useReadingPace')
const mount = <R,>(hook: (enabled: boolean) => R, enabled: boolean) => renderHook(() => hook(enabled), {})
const settle = () => act(async () => {})

const STATUS = 'GET /me/v2/status'
/** A fresh app start with V2 off (status 404): the real gate passes every call through. */
async function v2Off() {
  vi.resetModules()
  vi.unstubAllGlobals()
  getReadingPace.mockReset()
  const { initApi } = await import('@textstack/shared')
  initApi({ baseUrl: 'http://localhost:8080', getAccessToken: async () => 't', onUnauthorized: async () => null })
  fakeApi({ [STATUS]: [{ status: 404 }] })
}

describe('useFetchedReadingPace', () => {
  beforeEach(v2Off)

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

  it('time left still shows on V2: the pace is refused before any request and the fallback pace answers', async () => {
    // M5 (#1031): no pace route on V2; the real gate refuses it and the V2 reader keeps a time left.
    const calls = fakeApi({ [STATUS]: [{ status: 200, body: { maxPartBytes: 1024 } }] })
    const h = mount((await hooks()).useFetchedReadingPace, true)
    await settle()
    await settle()
    expect(h.result.current).toBe(FALLBACK_WPM)
    expect(getReadingPace).not.toHaveBeenCalled()
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([STATUS])
    h.unmount()
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
  beforeEach(v2Off)

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
