import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { createEngine, type ReaderEngine } from '@textstack/reader-engine'
import type { ReaderSettings } from '../../hooks/useReaderSettings'
import { sanitizeHtml } from '../../utils/sanitize'
import { setMountedEngine, unmountEngine } from '../../lib/readerEngine'
import { reportError } from '../../lib/sentry'

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
  /** The engine could not open this chapter (#849): the host shows the chapter error. */
  onEngineError?: (chapterSlug: string) => void
}

function fontFamily(f: ReaderSettings['fontFamily']): string {
  switch (f) {
    case 'serif':
      return 'var(--font-serif)'
    case 'sans':
      return 'var(--font-sans)'
    case 'dyslexic':
      return '"OpenDyslexic", sans-serif'
  }
}

export const ReaderSection = forwardRef<ReaderSectionHandle, Props>(function ReaderSection(
  { chapterId, chapterSlug, chapterIndex, html, settings, onTap, onEngineOpened, onEngineError },
  ref,
) {
  const articleRef = useRef<HTMLElement | null>(null)
  // Sanitised once per html: the open effect below reopens the chapter whenever this changes.
  const cleanHtml = useMemo(() => sanitizeHtml(html), [html])

  // ADR-025 Phase 4: the engine renders the chapter into the article and keeps the
  // place; useReaderScrollSync drives it through `mountedEngineFor`.
  const engineRef = useRef<ReaderEngine | null>(null)
  const onTapRef = useRef(onTap)
  onTapRef.current = onTap
  const onEngineOpenedRef = useRef(onEngineOpened)
  onEngineOpenedRef.current = onEngineOpened
  const onEngineErrorRef = useRef(onEngineError)
  onEngineErrorRef.current = onEngineError
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
    let live = true   // false once this open is replaced (chapter / html change) or the engine is unmounted
    // New html for the chapter on screen (a cache → network refresh) reopens where the reader is.
    const here = engine.current()
    setMountedEngine({ engine, href: chapterSlug })
    void engine.open({ href: chapterSlug, layout: 'reflow', html: cleanHtml }, here?.href === chapterSlug ? here : undefined)
      .then(
        // Only the open still current: a newer open, an unmount or StrictMode's (dev) destroy supersedes it.
        // A goTo that overtook it also resolves 'superseded', but its document landed (engine rule E46).
        (result) => {
          if (live && (result !== 'superseded' || engine.current()?.href === chapterSlug)) onEngineOpenedRef.current?.(chapterSlug)
        },
        // Only open's own rejection: an error thrown by onEngineOpened is not the engine failing.
        (e: unknown) => {
          if (!live) return   // a destroy mid-open is not a failure
          reportError(e, { area: 'reader-engine', chapter: chapterSlug })
          onEngineErrorRef.current?.(chapterSlug)
        },
      )
    return () => { live = false }
  }, [cleanHtml, chapterSlug])
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
