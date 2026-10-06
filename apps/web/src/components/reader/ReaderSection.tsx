import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import type { ReaderSettings } from '../../hooks/useReaderSettings'
import { sanitizeHtml } from '../../utils/sanitize'
import type { Overlayer } from '@textstack/reader-overlay'
import { ReaderOverlay } from './ReaderOverlay'

// One chapter, native scroll within, overlay on top. Unwired in slice 3 —
// slice 7 swaps ReaderPage over to this. Annotation layers attach via
// overlayerRef.

export interface ReaderSectionHandle {
  /** DOM article element — used by selection logic + scroll-into-range. */
  article: HTMLElement | null
  /** Overlayer instance — annotation layers feed ranges here. */
  overlayer: Overlayer | null
}

interface Props {
  chapterId: string
  /** Lets a highlight saved under an offline cache key ("editionId:slug") find its chapter. */
  chapterSlug?: string
  chapterIndex: number
  html: string
  settings: ReaderSettings
  /** When false, disables the overlay entirely (kills annotations). */
  overlayEnabled?: boolean
  onTap?: () => void
  onDoubleTap?: () => void
}

function fontFamily(f: ReaderSettings['fontFamily']): string {
  switch (f) {
    case 'serif':
      return 'Georgia, "Times New Roman", serif'
    case 'sans':
      return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    case 'dyslexic':
      return '"OpenDyslexic", sans-serif'
  }
}

export const ReaderSection = forwardRef<ReaderSectionHandle, Props>(function ReaderSection(
  { chapterId, chapterSlug, chapterIndex, html, settings, overlayEnabled = true },
  ref,
) {
  const articleRef = useRef<HTMLElement | null>(null)
  const overlayerRef = useRef<Overlayer | null>(null)
  // Stable object: React 19 re-sets innerHTML whenever this prop's identity
  // changes, so a literal here rebuilt the chapter DOM on EVERY render (each
  // scroll-progress tick) — killing every live Range: highlights, vocab marks,
  // the selection, a drawer jump's freshly painted highlight.
  const innerHtml = useMemo(() => ({ __html: sanitizeHtml(html) }), [html])

  useImperativeHandle(
    ref,
    () => ({
      get article() {
        return articleRef.current
      },
      get overlayer() {
        return overlayerRef.current
      },
    }),
    [],
  )

  return (
    <div className="reader-section" style={{ position: 'relative' }}>
      <article
        ref={articleRef}
        className="reader-section__article"
        data-chapter-id={chapterId}
        data-chapter-slug={chapterSlug}
        data-chapter-index={chapterIndex}
        style={{
          fontSize: `${settings.fontSize}px`,
          lineHeight: settings.lineHeight,
          fontFamily: fontFamily(settings.fontFamily),
          textAlign: settings.textAlign,
        }}
        dangerouslySetInnerHTML={innerHtml}
      />
      <ReaderOverlay
        containerRef={articleRef}
        overlayerRef={overlayerRef}
        enabled={overlayEnabled}
      />
    </div>
  )
})
