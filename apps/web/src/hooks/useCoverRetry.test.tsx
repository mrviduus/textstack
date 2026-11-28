import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const imageSrc = vi.fn<(url: string) => string | Promise<string | undefined>>()
vi.mock('../platform', () => ({ platform: { imageSrc: (url: string) => imageSrc(url) } }))

import { useCoverRetry } from './useCoverRetry'

afterEach(() => { vi.useRealTimers(); imageSrc.mockReset() })

describe('a cover whose src the platform fetches (Android)', () => {
  it('is hidden until the image is there, then shows it', async () => {
    imageSrc.mockResolvedValue('blob:cover')
    const { result } = renderHook(() => useCoverRetry('https://api/cover/1'))
    expect(result.current[0]).toBe(true)
    await waitFor(() => expect(result.current[2]).toBe('blob:cover'))
    expect(result.current[0]).toBe(false)
  })

  it('hides again when the image does not draw, and does not keep its src', async () => {
    imageSrc.mockResolvedValue('blob:broken')
    const { result } = renderHook(() => useCoverRetry('https://api/cover/2'))
    await waitFor(() => expect(result.current[0]).toBe(false))
    act(() => result.current[1]())
    expect(result.current[0]).toBe(true)
    expect(result.current[2]).toBeUndefined()
  })

  it('asks again after a failed fetch', async () => {
    vi.useFakeTimers()
    imageSrc.mockResolvedValueOnce(undefined).mockResolvedValueOnce('blob:cover')
    const { result } = renderHook(() => useCoverRetry('https://api/cover/3'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current[0]).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(result.current[2]).toBe('blob:cover')
    expect(imageSrc).toHaveBeenCalledTimes(2)
  })
})

describe('a cover on the web', () => {
  it('loads the URL itself', () => {
    imageSrc.mockImplementation((url) => url)
    const { result } = renderHook(() => useCoverRetry('/api/cover/4'))
    expect(result.current).toEqual([false, expect.any(Function), '/api/cover/4'])
  })
})
