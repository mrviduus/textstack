import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../lib/sse', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/sse')>()
  return { ...actual, postSse: vi.fn() }
})
vi.mock('../api/explain', () => ({ explain: vi.fn(), API_BASE: '' }))
vi.mock('../lib/offlineDb', () => ({
  getCachedExplain: vi.fn().mockResolvedValue(null),
  cacheExplain: vi.fn().mockResolvedValue(undefined),
}))

import { postSse, SseUnsupportedError, type SseEvent } from '../lib/sse'
import { explain as explainJson } from '../api/explain'
import { getCachedExplain } from '../lib/offlineDb'
import { useExplain } from './useExplain'

const mockPostSse = postSse as unknown as ReturnType<typeof vi.fn>
const mockExplainJson = explainJson as unknown as ReturnType<typeof vi.fn>
const mockGetCached = getCachedExplain as unknown as ReturnType<typeof vi.fn>

const REQ = { word: 'quorum', sentence: 'A quorum of replicas.', targetLang: 'en' }

/** Makes postSse emit the given events, then resolve. */
function emit(...events: SseEvent[]) {
  mockPostSse.mockImplementationOnce(
    async (_url: string, _body: unknown, onEvent: (e: SseEvent) => void) => {
      for (const e of events) onEvent(e)
    },
  )
}

describe('useExplain (streaming)', () => {
  beforeEach(() => {
    mockPostSse.mockReset()
    mockExplainJson.mockReset()
    mockGetCached.mockReset().mockResolvedValue(null)
  })

  it('accumulates deltas and finishes on done', async () => {
    emit(
      { event: 'delta', data: 'A quorum ' },
      { event: 'delta', data: 'is a majority.' },
      { event: 'done', data: '{"word":"quorum","cached":false}' },
    )
    const { result } = renderHook(() => useExplain())

    await act(() => result.current.explain(REQ))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.explanation).toBe('A quorum is a majority.')
    expect(result.current.error).toBeNull()
    expect(result.current.cached).toBe(false)
  })

  it('marks cached answers from the done payload', async () => {
    emit(
      { event: 'delta', data: 'Cached text.' },
      { event: 'done', data: '{"word":"quorum","cached":true}' },
    )
    const { result } = renderHook(() => useExplain())

    await act(() => result.current.explain(REQ))

    await waitFor(() => expect(result.current.cached).toBe(true))
    expect(result.current.explanation).toBe('Cached text.')
  })

  it('surfaces a server error event, keeping partial text', async () => {
    emit(
      { event: 'delta', data: 'Partial ' },
      { event: 'error', data: 'Explain service unavailable' },
    )
    const { result } = renderHook(() => useExplain())

    await act(() => result.current.explain(REQ))

    await waitFor(() => expect(result.current.error).toBe('Explain service unavailable'))
    expect(result.current.explanation).toBe('Partial ')
    expect(result.current.isLoading).toBe(false)
  })

  it('falls back to the JSON request when streaming is unsupported', async () => {
    mockPostSse.mockRejectedValueOnce(new SseUnsupportedError())
    mockExplainJson.mockResolvedValueOnce({ explanation: 'Plain answer.', cached: false })
    const { result } = renderHook(() => useExplain())

    await act(() => result.current.explain(REQ))

    await waitFor(() => expect(result.current.explanation).toBe('Plain answer.'))
    expect(mockExplainJson).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()
  })

  it('serves the local offline cache without any network call', async () => {
    mockGetCached.mockResolvedValueOnce({ explanation: 'From device cache.' })
    const { result } = renderHook(() => useExplain())

    await act(() => result.current.explain(REQ))

    await waitFor(() => expect(result.current.explanation).toBe('From device cache.'))
    expect(result.current.cached).toBe(true)
    expect(mockPostSse).not.toHaveBeenCalled()
  })

  it('sets error when the request itself fails (e.g. rate limit)', async () => {
    mockPostSse.mockRejectedValueOnce(new Error('Too many requests, try again later'))
    const { result } = renderHook(() => useExplain())

    await act(() => result.current.explain(REQ))

    await waitFor(() => expect(result.current.error).toMatch(/Too many requests/))
    expect(result.current.explanation).toBeNull()
  })
})

describe('useExplain — unmount (#1269 review)', () => {
  it('explain_Unmounted_TheStreamIsAborted', async () => {
    mockGetCached.mockReset().mockResolvedValue(null)
    let signal: AbortSignal | undefined
    mockPostSse.mockReset().mockImplementationOnce((_u: string, _b: unknown, _e: unknown, s: AbortSignal) => {
      signal = s
      return new Promise(() => {})
    })
    const { result, unmount } = renderHook(() => useExplain())
    act(() => { void result.current.explain(REQ) })
    await waitFor(() => expect(signal).toBeDefined())
    expect(signal!.aborted).toBe(false)
    unmount()
    expect(signal!.aborted).toBe(true)
  })
})
