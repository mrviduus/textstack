import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLanguage } from '../context/LanguageContext'

interface UseReaderNavigationOptions {
  bookSlug: string
  currentPage: number
  totalPages: number
  prevChapterSlug?: string
  nextChapterSlug?: string
  prevPage: () => void
  nextPage: () => void
}

export function useReaderNavigation({
  bookSlug,
  currentPage,
  totalPages,
  prevChapterSlug,
  nextChapterSlug,
  prevPage,
  nextPage,
}: UseReaderNavigationOptions) {
  const navigate = useNavigate()
  const { getLocalizedPath } = useLanguage()

  const navigateToChapter = useCallback((slug: string) => {
    navigate(getLocalizedPath(`/books/${bookSlug}/${slug}`))
  }, [navigate, getLocalizedPath, bookSlug])

  const handleNextPage = useCallback(() => {
    if (currentPage < totalPages - 1) {
      nextPage()
    } else if (nextChapterSlug) {
      navigateToChapter(nextChapterSlug)
    }
  }, [currentPage, totalPages, nextPage, nextChapterSlug, navigateToChapter])

  const handlePrevPage = useCallback(() => {
    if (currentPage > 0) {
      prevPage()
    } else if (prevChapterSlug) {
      navigateToChapter(prevChapterSlug)
    }
  }, [currentPage, prevPage, prevChapterSlug, navigateToChapter])

  return {
    navigateToChapter,
    handleNextPage,
    handlePrevPage,
  }
}
