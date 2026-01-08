import { useState, useEffect, useCallback, RefObject } from 'react'

// Legacy scroll progress tracker (keep for backwards compat)
export function useScrollProgress() {
  const [progress, setProgress] = useState(0)

  const updateProgress = useCallback(() => {
    const scrollTop = window.scrollY
    const docHeight = document.documentElement.scrollHeight - window.innerHeight

    if (docHeight <= 0) {
      setProgress(0)
    } else {
      setProgress(Math.min(1, scrollTop / docHeight))
    }
  }, [])

  useEffect(() => {
    updateProgress()

    window.addEventListener('scroll', updateProgress, { passive: true })
    window.addEventListener('resize', updateProgress, { passive: true })

    return () => {
      window.removeEventListener('scroll', updateProgress)
      window.removeEventListener('resize', updateProgress)
    }
  }, [updateProgress])

  return { progress, recalculate: updateProgress }
}

// Page-based pagination for BookFusion-style reader
interface PaginationState {
  currentPage: number
  totalPages: number
  progress: number
  pagesLeft: number
}

interface PaginationActions {
  nextPage: () => void
  prevPage: () => void
  goToPage: (page: number) => void
}

export function usePagination(
  contentRef: RefObject<HTMLElement | null>,
  containerRef: RefObject<HTMLElement | null>
): PaginationState & PaginationActions & { recalculate: () => void } {
  const [currentPage, setCurrentPage] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const columnGap = 48 // px between columns

  const recalculate = useCallback(() => {
    const content = contentRef.current
    const container = containerRef.current
    if (!content || !container) return

    const containerWidth = container.clientWidth
    const scrollWidth = content.scrollWidth

    // Each "page" is one viewport width (2 columns)
    const pageWidth = containerWidth + columnGap
    const pages = Math.max(1, Math.ceil(scrollWidth / pageWidth))

    setTotalPages(pages)

    // Clamp current page if content shrunk
    setCurrentPage((prev) => Math.min(prev, pages - 1))
  }, [contentRef, containerRef, columnGap])

  // Recalculate on mount and resize
  useEffect(() => {
    // Wait for CSS columns to finish layout
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        recalculate()
      })
    })

    const handleResize = () => {
      requestAnimationFrame(() => {
        recalculate()
      })
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [recalculate])

  // Recalculate when content changes (images load, etc)
  useEffect(() => {
    const content = contentRef.current
    if (!content) return

    const observer = new ResizeObserver(() => {
      // Wait for CSS columns to finish layout
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          recalculate()
        })
      })
    })

    observer.observe(content)
    return () => observer.disconnect()
  }, [contentRef, recalculate])

  const goToPage = useCallback((page: number) => {
    const content = contentRef.current
    const container = containerRef.current
    if (!content || !container) return

    const clampedPage = Math.max(0, Math.min(page, totalPages - 1))
    setCurrentPage(clampedPage)

    const pageWidth = container.clientWidth + columnGap
    content.style.transform = `translateX(-${clampedPage * pageWidth}px)`
  }, [contentRef, containerRef, totalPages, columnGap])

  const nextPage = useCallback(() => {
    if (currentPage < totalPages - 1) {
      goToPage(currentPage + 1)
    }
  }, [currentPage, totalPages, goToPage])

  const prevPage = useCallback(() => {
    if (currentPage > 0) {
      goToPage(currentPage - 1)
    }
  }, [currentPage, goToPage])

  const progress = totalPages > 1 ? currentPage / (totalPages - 1) : 0
  const pagesLeft = totalPages - currentPage - 1

  return {
    currentPage,
    totalPages,
    progress,
    pagesLeft,
    nextPage,
    prevPage,
    goToPage,
    recalculate,
  }
}
