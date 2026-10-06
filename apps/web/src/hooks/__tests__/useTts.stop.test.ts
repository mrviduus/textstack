import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// L1: TTS kept speaking after a chapter change or after leaving the reader.

vi.mock('../../api/tts', () => ({
  fetchTtsAudio: vi.fn(async () => new ArrayBuffer(8)),
  fetchTtsTimestamps: vi.fn(async () => []),
  TtsRateLimitError: class extends Error {},
}))
vi.mock('../../lib/offlineDb', () => ({
  getCachedTtsAudio: vi.fn(async () => null),
  cacheTtsAudio: vi.fn(async () => {}),
}))

import { useTts } from '../useTts'

const pause = vi.fn()
beforeEach(() => {
  pause.mockClear()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause)
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
})

async function speaking(key: string) {
  const h = renderHook(({ k }) => useTts(k), { initialProps: { k: key } })
  await act(async () => { await h.result.current.speak('hello world', 'en') })
  expect(h.result.current.isPlaying).toBe(true)
  pause.mockClear()
  return h
}

describe('useTts — playback ends with its chapter / page', () => {
  it('a new stop key (chapter change) stops playback', async () => {
    const h = await speaking('ch-1')
    h.rerender({ k: 'ch-2' })
    expect(pause).toHaveBeenCalled()
    expect(h.result.current.isPlaying).toBe(false)
  })

  it('unmount (leaving the reader) stops playback', async () => {
    const h = await speaking('ch-1')
    h.unmount()
    expect(pause).toHaveBeenCalled()
  })

  it('a re-render with the same key keeps playing', async () => {
    const h = await speaking('ch-1')
    h.rerender({ k: 'ch-1' })
    expect(pause).not.toHaveBeenCalled()
    expect(h.result.current.isPlaying).toBe(true)
  })
})
