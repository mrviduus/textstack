import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTts } from './useTts'

// #1272 review: one shared audio element; a second instance taking it over ends the first call for good, so the
// first call's play() rejecting late (after the second set its audio) touches nothing of the second.

vi.mock('../api/tts', () => ({
  fetchTtsAudio: async () => new ArrayBuffer(4),
  fetchTtsTimestamps: async () => [],
  TtsRateLimitError: class extends Error {},
}))
vi.mock('../lib/offlineDb', async (orig) => ({ ...(await orig<object>()), getCachedTtsAudio: async () => null, cacheTtsAudio: async () => {} }))

let urls = 0
const revoked: string[] = []
let rejectFirst: ((e: unknown) => void) | null = null

beforeEach(() => {
  urls = 0
  revoked.length = 0
  rejectFirst = null
  URL.createObjectURL = () => `blob:tts-${++urls}`
  URL.revokeObjectURL = (u: string) => { revoked.push(u) }
  let calls = 0
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => {
    // The first play() stays pending until the test rejects it; the others play.
    if (++calls === 1) return new Promise<void>((_, reject) => { rejectFirst = reject })
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })

describe('useTts takeover', () => {
  it('aTakenOverCallsLatePlayRejection_LeavesTheNewCallPlaying', async () => {
    const a = renderHook(() => useTts())
    const b = renderHook(() => useTts())
    const aEnd = vi.fn()
    const bEnd = vi.fn()
    let aPlayed: Promise<boolean> | undefined
    act(() => { aPlayed = a.result.current.speak('Teich', 'de', 1, { timestamps: false, onEnd: aEnd }) })
    await settle()
    expect(rejectFirst).not.toBeNull()
    let bPlayed: Promise<boolean> | undefined
    act(() => { bPlayed = b.result.current.speak('Wald', 'de', 1, { timestamps: false, onEnd: bEnd }) })
    await settle()
    expect(await bPlayed).toBe(true)
    // A's play() rejects only now, B's audio already set.
    await act(async () => { rejectFirst!(new DOMException('interrupted', 'AbortError')) })
    await settle()
    expect(await aPlayed).toBe(false)
    expect(revoked).not.toContain('blob:tts-2')
    expect(b.result.current.isPlaying).toBe(true)
    expect(b.result.current.error).toBeNull()
    expect(bEnd).not.toHaveBeenCalled()
    expect(aEnd).toHaveBeenCalledWith(false)
  })
})
