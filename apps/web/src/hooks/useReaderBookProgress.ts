import { useState, useEffect, useRef, useMemo } from 'react'
import { computeBookProgress } from '@textstack/shared'
import type { BookDetail } from '../types/api'
import type { ReaderMode, NormalizedBook } from './useReaderChapter'

interface Params {
  mode: ReaderMode
  publicBook: BookDetail | null
  book: NormalizedBook | null
  /** The URL's chapter. */
  chapterIdentifier: string | undefined
  /** The rendered chapter's id — re-binds the scroll listener per chapter. */
  chapterId: string | undefined
  /** "Finish book" pressed: the bar shows 100%. */
  bookCompleted: boolean
}

/**
 * Where the reader is in the book: intra-chapter scroll (window scroll) and the
 * book-wide percent, clamped monotonically within a session.
 */
export function useReaderBookProgress({ mode, publicBook, book, chapterIdentifier, chapterId, bookCompleted }: Params) {
  // Chapter list for progress + TOC. URL chapter is authoritative — single
  // chapter mounted per view.
  const chapterList = useMemo(() => {
    if (mode === 'public' && publicBook) {
      return publicBook.chapters.map(c => ({
        identifier: c.slug,
        title: c.title,
        chapterNumber: c.chapterNumber,
        wordCount: c.wordCount,
      }))
    }
    if (mode === 'userbook' && book) {
      return book.chapters.map(c => ({
        identifier: c.identifier,
        title: c.title,
        chapterNumber: c.chapterNumber,
        wordCount: c.wordCount ?? null,
      }))
    }
    return null
  }, [mode, publicBook, book])

  // Single chapter mounted; native window scroll drives intra-chapter progress.
  const [overlayScrollProgress, setOverlayScrollProgress] = useState(0)
  useEffect(() => {
    const read = () => {
      const doc = document.scrollingElement || document.documentElement
      const max = doc.scrollHeight - doc.clientHeight
      if (max <= 0) { setOverlayScrollProgress(0); return }
      setOverlayScrollProgress(Math.min(1, Math.max(0, doc.scrollTop / max)))
    }
    read()
    window.addEventListener('scroll', read, { passive: true })
    window.addEventListener('resize', read)
    return () => {
      window.removeEventListener('scroll', read)
      window.removeEventListener('resize', read)
    }
  }, [chapterId])

  // Overall book progress = words-read / total-words across chapters,
  // driven by URL chapter + intra-chapter scroll.
  const calculatedProgress = useMemo(() => {
    const chapters = chapterList?.map(c => ({ slug: c.identifier, wordCount: c.wordCount })) ?? []
    // Denominator = canonical book-wide word total so the client's book-% matches
    // the server's Σ chapter WordCount — the same value persisted verbatim into
    // UserBook.ProgressPercent and read back by the library card + shelf. For user
    // books that's book.totalWordCount; for public editions we let computeBookProgress
    // fall back to the chapter-list sum, which already equals Σ Chapters.WordCount.
    const totalWords = mode === 'userbook' ? (book?.totalWordCount || undefined) : undefined
    return computeBookProgress(chapters, chapterIdentifier, overlayScrollProgress, totalWords) ?? 0
  }, [chapterList, chapterIdentifier, overlayScrollProgress, mode, book?.totalWordCount])

  // Force 100% when book is completed
  const rawProgress = bookCompleted ? 1 : calculatedProgress

  // Clamp progress monotonically within a session: scrolling down must never
  // reduce the bar. Fixes jitter from chapter-boundary scroll handoff and
  // Math.round flipping between 99/100.
  const maxProgressRef = useRef(0)
  useEffect(() => {
    maxProgressRef.current = 0
  }, [book?.id])
  if (rawProgress > maxProgressRef.current) maxProgressRef.current = rawProgress
  const overallProgress = maxProgressRef.current

  const totalChapters = chapterList?.length ?? 0
  const currentChapterIndex = useMemo(() => {
    if (!chapterList) return -1
    const id = chapterIdentifier || ''
    if (!id) return -1
    return chapterList.findIndex(c => c.identifier === id)
  }, [chapterList, chapterIdentifier])

  return { overlayScrollProgress, overallProgress, totalChapters, currentChapterIndex }
}
