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
    expect(explain).toHaveBeenCalledWith(expect.objectContaining({ word: 'quorum', sentence: 'quorum,' }))
  })

  it('a long selection with no sentence: the whole selection (trimmed) is the sentence, not its first word', () => {
    const { result } = renderHook(() => useExplainPopup({ editionId: 'e1', nativeLanguage: 'en' }))
    const long = 'A quorum of replicas must agree before the write is acknowledged, so a minority partition can never accept a write that a majority will later lose.'
    expect(long.length).toBeGreaterThan(140)

    act(() => result.current.openFromSelection(`  ${long}\n`, new DOMRect(0, 0, 10, 10), undefined))

    expect(explain).toHaveBeenLastCalledWith(expect.objectContaining({ sentence: long }))
  })

  it('the fallback sentence is cut to the engine sentence length (200)', () => {
    const { result } = renderHook(() => useExplainPopup({ editionId: 'e1', nativeLanguage: 'en' }))
    act(() => result.current.openFromSelection('word '.repeat(60), new DOMRect(0, 0, 10, 10), ''))
    expect(explain.mock.lastCall![0].sentence).toHaveLength(200)
  })
})
