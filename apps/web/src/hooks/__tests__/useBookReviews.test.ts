import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const getBookInsights = vi.fn()
const deleteBookInsight = vi.fn()
vi.mock('@textstack/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@textstack/shared')>()),
  insightsApi: {
    getBookInsights: (...a: unknown[]) => getBookInsights(...a),
    deleteBookInsight: (...a: unknown[]) => deleteBookInsight(...a),
  },
}))

import { useBookReviews } from '../useBookReviews'

describe('useBookReviews', () => {
  // The bug: the insights section kept its own copy, so a delete left "Reviewed" on the chapter row.
  it('remove() drops the insight and its chapter review from the one shared list', async () => {
    getBookInsights.mockResolvedValue([
      { id: 'i1', chapterSlug: 'ch-1', review: { summary: 's' } },
    ])
    deleteBookInsight.mockResolvedValue(undefined)
    const target = { userBookId: 'b1' }
    const { result } = renderHook(() => useBookReviews(target))
    await waitFor(() => expect(result.current.reviews.has('ch-1')).toBe(true))

    await act(() => result.current.remove('i1'))

    expect(deleteBookInsight).toHaveBeenCalledWith('i1')
    expect(result.current.insights).toHaveLength(0)
    expect(result.current.reviews.has('ch-1')).toBe(false)
  })
})
