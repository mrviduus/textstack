import { useEffect, useRef, useCallback, Fragment } from 'react'
import type { ReaderSettings } from '../../hooks/useReaderSettings'
import type { LoadedChapter } from '../../hooks/useScrollReader'

interface Props {
  chapters: LoadedChapter[]
  settings: ReaderSettings
  isLoadingMore: boolean
  onLoadMore: () => void
  chapterRefs: React.MutableRefObject<Map<string, HTMLElement>>
  onTap?: () => void
}

function getFontFamily(family: ReaderSettings['fontFamily']): string {
  switch (family) {
    case 'serif':
      return 'Georgia, "Times New Roman", serif'
    case 'sans':
      return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    case 'dyslexic':
      return '"OpenDyslexic", sans-serif'
  }
}

export function ScrollReaderContent({
  chapters,
  settings,
  isLoadingMore,
  onLoadMore,
  chapterRefs,
  onTap,
}: Props) {
  const bottomSentinelRef = useRef<HTMLDivElement>(null)
  const fontFamily = getFontFamily(settings.fontFamily)

  // Handle tap to toggle immersive mode
  const handleClick = useCallback((e: React.MouseEvent) => {
    // Don't trigger on links
    const target = e.target as HTMLElement
    if (target.tagName === 'A' || target.closest('a')) return
    onTap?.()
  }, [onTap])

  // Register chapter ref
  const setChapterRef = useCallback(
    (slug: string, el: HTMLElement | null) => {
      if (el) {
        chapterRefs.current.set(slug, el)
      } else {
        chapterRefs.current.delete(slug)
      }
    },
    [chapterRefs]
  )

  // IntersectionObserver for loading more chapters
  useEffect(() => {
    const sentinel = bottomSentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isLoadingMore) {
          onLoadMore()
        }
      },
      {
        root: null,
        rootMargin: '200px', // Start loading 200px before reaching bottom
        threshold: 0,
      }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [onLoadMore, isLoadingMore])

  if (chapters.length === 0) {
    return (
      <div className="scroll-reader scroll-reader--loading">
        <div className="scroll-reader__spinner">Loading...</div>
      </div>
    )
  }

  return (
    <div className="scroll-reader" onClick={handleClick}>
      {chapters.map((chapter, i) => (
        <Fragment key={chapter.slug}>
          {/* Chapter separator (not for first chapter) */}
          {i > 0 && (
            <div className="chapter-separator">
              <div className="chapter-separator__line" />
              <span className="chapter-separator__title">{chapter.title}</span>
              <div className="chapter-separator__line" />
            </div>
          )}

          {/* Chapter content */}
          <article
            ref={(el) => setChapterRef(chapter.slug, el)}
            className="scroll-reader__chapter"
            data-chapter-slug={chapter.slug}
            data-chapter-index={chapter.index}
            style={{
              fontSize: `${settings.fontSize}px`,
              lineHeight: settings.lineHeight,
              fontFamily,
              textAlign: settings.textAlign,
            }}
            dangerouslySetInnerHTML={{ __html: chapter.html }}
          />
        </Fragment>
      ))}

      {/* Bottom sentinel for infinite scroll */}
      <div ref={bottomSentinelRef} className="scroll-reader__sentinel" />

      {/* Loading indicator */}
      {isLoadingMore && (
        <div className="scroll-reader__loading">
          <span>Loading more...</span>
        </div>
      )}
    </div>
  )
}
