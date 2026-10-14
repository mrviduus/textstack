import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const explain = vi.fn()
vi.mock('./useExplain', () => ({
  useExplain: () => ({ explanation: null, isLoading: false, error: null, explain, reset: vi.fn() }),
}))

import { useExplainPopup } from './useExplainPopup'

describe('useExplainPopup', () => {
  it('explains with the selection as the sentence when the engine gave none', () => {
    const { result } = renderHook(() => useExplainPopup({ editionId: 'e1', nativeLanguage: 'en' }))

    act(() => result.current.openFromSelection('  quorum, ', new DOMRect(0, 0, 10, 10), ''))

    expect(result.current.show).toBe(true)
    expect(explain).toHaveBeenCalledWith(expect.objectContaining({ word: 'quorum', sentence: 'quorum' }))
  })
})
