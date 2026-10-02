import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useReaderChapter } from '../useReaderChapter'
import { ApiError } from '../../api/client'
import * as userBooks from '../../api/userBooks'

vi.mock('../useApi', () => ({
  useApi: () => ({ getBook: vi.fn(), getChapter: vi.fn() }),
}))
vi.mock('../useNetworkRecovery', () => ({
  useNetworkRecovery: () => ({ markFetchStart: vi.fn(), wasAbortedDueToWake: () => false }),
}))
vi.mock('../../api/userBooks', () => ({
  getUserBook: vi.fn(),
  getUserBookChapter: vi.fn(),
}))

const mockGetUserBook = vi.mocked(userBooks.getUserBook)
const mockGetUserBookChapter = vi.mocked(userBooks.getUserBookChapter)

function pdfBook(hasOriginalPdf: boolean): userBooks.UserBookDetail {
  return {
    id: 'b1',
    title: 'My PDF',
    slug: 'my-pdf',
    language: 'en',
    author: null,
    description: null,
    coverPath: null,
    genre: null,
    publishedYear: null,
    totalWordCount: 100,
    status: 'Processing',
    errorMessage: null,
    chapters: [],
    toc: null,
    createdAt: '',
    updatedAt: '',
    completedAt: null,
    hasOriginalPdf,
  }
}

describe('useReaderChapter — userbook chapterless / 404 decoupling (ADR-012)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('chapterless (no slug) → book loads, chapter is null, no error, no chapter fetch', async () => {
    mockGetUserBook.mockResolvedValue(pdfBook(true))

    const { result } = renderHook(() =>
      useReaderChapter({
        mode: 'userbook',
        userBookId: 'b1',
        userChapterSlug: undefined,
        isAuthenticated: true,
      }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.book?.id).toBe('b1')
    expect(result.current.chapter).toBeNull()
    expect(result.current.error).toBeNull()
    expect(mockGetUserBookChapter).not.toHaveBeenCalled()
  })

  it('slug present but chapter 404s AND hasOriginalPdf → swallow, chapter null, no error', async () => {
    mockGetUserBook.mockResolvedValue(pdfBook(true))
    mockGetUserBookChapter.mockRejectedValue(new ApiError(404, 'Chapter not found'))

    const { result } = renderHook(() =>
      useReaderChapter({
        mode: 'userbook',
        userBookId: 'b1',
        userChapterSlug: 'ch-1',
        isAuthenticated: true,
      }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.book?.id).toBe('b1')
    expect(result.current.chapter).toBeNull()
    expect(result.current.error).toBeNull()
    expect(mockGetUserBookChapter).toHaveBeenCalled()
  })

  it('EPUB (no original PDF) chapter 404 → still errors', async () => {
    mockGetUserBook.mockResolvedValue(pdfBook(false))
    mockGetUserBookChapter.mockRejectedValue(new ApiError(404, 'Chapter not found'))

    const { result } = renderHook(() =>
      useReaderChapter({
        mode: 'userbook',
        userBookId: 'b1',
        userChapterSlug: 'ch-1',
        isAuthenticated: true,
      }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('Chapter not found')
    expect(result.current.chapter).toBeNull()
  })

  // The clip's source link comes from the detail the reader already loads —
  // no Read later list fetch (this module mock has no getUserBooks to call).
  it('clip sourceUrl comes from the one detail request', async () => {
    mockGetUserBook.mockResolvedValue({ ...pdfBook(true), sourceUrl: 'https://example.com/post' })

    const { result } = renderHook(() =>
      useReaderChapter({ mode: 'userbook', userBookId: 'b1', isAuthenticated: true }),
    )

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.book?.sourceUrl).toBe('https://example.com/post')
    expect(mockGetUserBook).toHaveBeenCalledTimes(1)
  })
})
