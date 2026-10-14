import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { createEngine, type ReaderEngine } from '@textstack/reader-engine'
import type { ReaderSettings } from '../../hooks/useReaderSettings'
import { sanitizeHtml } from '../../utils/sanitize'
import { setMountedEngine, unmountEngine } from '../../lib/readerEngine'

// One chapter, shown by the reader engine (ADR-025), which draws every decoration and takes every tap.

export interface ReaderSectionHandle {
  /** DOM article element — used by selection logic + scroll-into-range. */
  article: HTMLElement | null
}

interface Props {
  chapterId: string
  /** Lets a highlight saved under an offline cache key ("editionId:slug") find its chapter. */
  chapterSlug?: string
  chapterIndex: number
  html: string
  settings: ReaderSettings
  onTap?: () => void
  /** The engine's open of this chapter has landed: the chapter is ready to position. */
  onEngineOpened?: (chapterSlug: string) => void
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
  { chapterId, chapterSlug, chapterIndex, html, settings, onTap, onEngineOpened },
  ref,
) {
  const articleRef = useRef<HTMLElement | null>(null)
  // Stable object: a new identity reopens the chapter in the engine, so a literal here reopened it on
  // EVERY render (each scroll-progress tick).
  const innerHtml = useMemo(() => ({ __html: sanitizeHtml(html) }), [html])

  // ADR-025 Phase 4: the engine renders the chapter into the article and keeps the
  // place; useReaderScrollSync drives it through `mountedEngineFor`.
  const engineRef = useRef<ReaderEngine | null>(null)
  const onTapRef = useRef(onTap)
  onTapRef.current = onTap
  const onEngineOpenedRef = useRef(onEngineOpened)
  onEngineOpenedRef.current = onEngineOpened
  useEffect(() => {
    if (!articleRef.current) return
    const engine = createEngine(articleRef.current)
    engineRef.current = engine
    engine.on('tap', () => onTapRef.current?.())   // #818: a tap on the chapter shows the bars
    return () => {
      unmountEngine(engine)
      engineRef.current = null
      engine.destroy()
    }
  }, [])
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !chapterSlug) return
    // New html for the chapter on screen (a cache → network refresh) reopens where the reader is.
    const here = engine.current()
    setMountedEngine({ engine, href: chapterSlug })
    void engine.open({ href: chapterSlug, layout: 'reflow', html: innerHtml.__html }, here?.href === chapterSlug ? here : undefined)
      // Only the engine still mounted: React StrictMode (dev) destroys the first one mid-open.
      .then(() => { if (engineRef.current === engine) onEngineOpenedRef.current?.(chapterSlug) })
  }, [innerHtml, chapterSlug])
  const { fontSize, lineHeight, fontFamily: family, textAlign } = settings
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.setStyle({ fontSize, lineHeight, family: fontFamily(family) })   // reads the place first…
    // …then centre (no engine align for it) reflows in the same frame; the engine re-anchors after both.
    articleRef.current!.style.textAlign = textAlign
  }, [fontSize, lineHeight, family, textAlign])

  useImperativeHandle(
    ref,
    () => ({
      get article() {
        return articleRef.current
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
      />
    </div>
  )
})
