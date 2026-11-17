import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const markComplete = vi.fn(async (_id: string) => {})
const unmarkComplete = vi.fn(async (_id: string) => {})
const del = vi.fn(async (_id: string) => {})

vi.mock('../../api/userBooks', () => ({
  markUserBookComplete: (id: string) => markComplete(id),
  unmarkUserBookComplete: (id: string) => unmarkComplete(id),
  deleteUserBook: (id: string) => del(id),
}))

import { useBookActions } from '../useBookActions'
import type { UserBook } from '../../api/userBooks'

const book: UserBook = {
  id: 'b1', title: 'B', slug: 'b', language: 'en', author: null, description: null,
  coverPath: null, genre: null, status: 'Ready', errorMessage: null, chapterCount: 5,
  totalWordCount: 1000, createdAt: '', completedAt: null, progressPercent: 0,
  progressUpdatedAt: null, progressChapterSlug: null,
}

beforeEach(() => {
  markComplete.mockClear(); unmarkComplete.mockClear()
  del.mockClear()
})

describe('useBookActions', () => {
  it('markFinished calls API and onChange', async () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useBookActions(book, { onChange }))
    await act(() => result.current.markFinished())
    expect(markComplete).toHaveBeenCalledWith('b1')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('markUnfinished calls unmark API', async () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useBookActions(book, { onChange }))
    await act(() => result.current.markUnfinished())
    expect(unmarkComplete).toHaveBeenCalledWith('b1')
    expect(onChange).toHaveBeenCalled()
  })

  it('remove uses onDelete callback when provided', async () => {
    const onChange = vi.fn()
    const onDelete = vi.fn()
    const { result } = renderHook(() => useBookActions(book, { onChange, onDelete }))
    await act(() => result.current.remove())
    expect(del).toHaveBeenCalledWith('b1')
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('falls back to onChange when no onDelete given', async () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useBookActions(book, { onChange }))
    await act(() => result.current.remove())
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('captures error and stops loading', async () => {
    del.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useBookActions(book, {}))
    await act(() => result.current.remove())
    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.isLoading).toBe(false)
  })

  it('blocks concurrent actions while pending', async () => {
    let release!: () => void
    markComplete.mockImplementationOnce(() => new Promise<void>(r => { release = () => r() }))
    const { result } = renderHook(() => useBookActions(book, {}))
    act(() => { result.current.markFinished() })
    await act(() => result.current.remove())
    expect(del).not.toHaveBeenCalled()
    release()
  })
})
