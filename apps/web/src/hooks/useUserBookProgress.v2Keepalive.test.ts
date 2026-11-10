import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('../api/userBooks', () => ({
  readUserBookProgress: vi.fn().mockResolvedValue(null),
  saveUserBookProgress: vi.fn(),
}))
// V2 on, the book known: the flush takes the keepalive PUT; the store and its guard are the real ones.
vi.mock('../api/v2', async (importActual) => ({
  ...(await importActual<typeof import('../api/v2')>()),
  v2Enabled: () => true,
  v2ProgressBody: () => ({ expectedRevision: null, fileId: 'f1' }),
}))

import { useUserBookProgress } from './useUserBookProgress'
import { v2Store, resetV2ForTests } from '../api/v2'
import { state } from '../../../../packages/shared/src/api/__tests__/fakeV2Api'

const KEY = 'userbook.progress.b1'

describe('the V2 keepalive flush and a sign-out (#1155)', () => {
  let answer!: (res: unknown) => void
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { answer = r })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetV2ForTests()
  })

  const flushAndAnswer = async (resetFirst: boolean) => {
    const { result } = renderHook(() => useUserBookProgress('b1'))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => result.current.saveProgress('ch-3', 0, 0.3, 'scroll:5'))
    act(() => result.current.flushSave())
    if (resetFirst) v2Store.reset()
    await act(async () => answer({ ok: true, json: async () => state('b1', 1) }))
  }

  it('acknowledges no write whose answer lands after the reset', async () => {
    await flushAndAnswer(true)
    expect(JSON.parse(localStorage.getItem(KEY)!).synced).toBeUndefined()
  })

  it('acknowledges the write whose answer lands with no reset', async () => {
    await flushAndAnswer(false)
    expect(JSON.parse(localStorage.getItem(KEY)!).synced).toBe(true)
  })
})
