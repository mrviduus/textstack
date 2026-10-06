import { describe, it, expect, vi, beforeEach } from 'vitest'

// Review #3: the reader's progress reads used to turn EVERY failure into `null` — the same value
// as "no row". A 5xx, a 401 or a dropped connection then read as "the server answered, nothing
// newer elsewhere", and a stale local place was trusted for good.

const authFetch = vi.fn()
vi.mock('../client', async () => {
  const shared = await vi.importActual<typeof import('@textstack/shared')>('@textstack/shared')
  return { authFetch: (...a: unknown[]) => authFetch(...a), API_BASE: '', ApiError: shared.ApiError }
})
vi.mock('../../lib/analytics', () => ({ trackBookUploaded: vi.fn() }))

import { ApiError } from '@textstack/shared'
import { readProgress, getProgress } from '../auth'
import { readUserBookProgress, getUserBookProgress } from '../userBooks'

const offline = () => Object.assign(new ApiError(0, 'Failed to fetch'), { isNetworkError: true })

beforeEach(() => authFetch.mockReset())

describe.each([
  ['readProgress', (s?: AbortSignal) => readProgress('e1', s)],
  ['readUserBookProgress', (s?: AbortSignal) => readUserBookProgress('b1', s)],
])('%s', (_name, read) => {
  it('a row → the row', async () => {
    authFetch.mockResolvedValue({ locator: 'scroll:c:1' })
    expect(await read()).toEqual({ locator: 'scroll:c:1' })
  })

  it('404 → null: the server answered, there is no row', async () => {
    authFetch.mockRejectedValueOnce(new ApiError(404, 'Not Found'))
    expect(await read()).toBeNull()
  })

  it('5xx, 401, offline, aborted → undefined: no answer', async () => {
    for (const e of [new ApiError(503, 'x'), new ApiError(401, 'Unauthorized'), offline(), new DOMException('aborted', 'AbortError')]) {
      authFetch.mockRejectedValueOnce(e)
      expect(await read()).toBeUndefined()
    }
  })

  it('passes the signal through', async () => {
    authFetch.mockResolvedValue({})
    const signal = new AbortController().signal
    await read(signal)
    expect(authFetch.mock.calls[0][1]).toEqual({ signal })
  })
})

describe('the old getters keep their contract for other callers', () => {
  it('any failure → null', async () => {
    authFetch.mockRejectedValueOnce(new ApiError(503, 'x')).mockRejectedValueOnce(new ApiError(503, 'x'))
    expect(await getProgress('e1')).toBeNull()
    expect(await getUserBookProgress('b1')).toBeNull()
  })
})
