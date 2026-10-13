import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Overlayer } from '@textstack/reader-overlay'
import { useOverlayAnnotations, type AnnotationSpec } from '../../hooks/useOverlayAnnotations'
import { useOverlayReflow } from '../../hooks/useOverlayReflow'
import { useContainerMutationObserver } from '../../hooks/useContainerMutationObserver'
import {
  computeVocabMatches,
  type ActiveBubbleSnapshot,
  type WordMatch,
} from '../../lib/vocabHighlightEngine'
import type { VocabMap } from '../../hooks/useReaderVocabulary'
import { VocabTranslationOverlay } from './VocabTranslationOverlay'

// Vocab underlines via the shared SVG Overlayer.

// CSS-var-driven so reader.css can override per theme without touching JS.
export const COLOR_PER_STAGE: Record<number, string> = {
  0: 'var(--reader-overlay-vocab-stage0, rgba(59, 130, 246, 0.5))',
  1: 'var(--reader-overlay-vocab-stage1, rgba(234, 179, 8, 0.5))',
  2: 'var(--reader-overlay-vocab-stage2, rgba(234, 179, 8, 0.4))',
  3: 'var(--reader-overlay-vocab-stage3, rgba(34, 197, 94, 0.4))',
  4: 'var(--reader-overlay-vocab-stage4, rgba(34, 197, 94, 0.25))',
}
export const ACTIVE_COLOR = 'var(--reader-overlay-vocab-active, rgba(59, 130, 246, 0.7))'

interface Props {
  containerRef: React.RefObject<HTMLElement | null>
  vocabMap: VocabMap
  showInlineTranslations?: boolean
  activeBubble?: ActiveBubbleSnapshot | null
}

export function VocabOverlayLayer({
  containerRef,
  vocabMap,
  showInlineTranslations = false,
  activeBubble = null,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const overlayer = useMemo(() => new Overlayer(), [])
  const [matches, setMatches] = useState<readonly WordMatch[]>([])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.appendChild(overlayer.element)
    return () => {
      if (overlayer.element.parentNode === host) host.removeChild(overlayer.element)
      overlayer.clear()
    }
  }, [overlayer])

  const activeWord = activeBubble?.word ?? null
  const activeTr = activeBubble?.translation ?? null
  const activeStable = useMemo<ActiveBubbleSnapshot | null>(
    () => (activeWord ? { word: activeWord, translation: activeTr } : null),
    [activeWord, activeTr],
  )

  const recompute = useCallback(() => {
    const container = containerRef.current
    if (!container) {
      setMatches([])
      return
    }
    try {
      const next = computeVocabMatches(container, {
        vocabMap,
        activeBubble: activeStable,
      })
      setMatches(next)
    } catch {
      setMatches([])
    }
  }, [containerRef, vocabMap, activeStable])

  useEffect(() => {
    recompute()
  }, [recompute])

  useContainerMutationObserver(containerRef, recompute)

  type IndexedMatch = WordMatch & { __idx: number }
  const map = useCallback(
    (m: IndexedMatch): AnnotationSpec<IndexedMatch> | null => ({
      item: m,
      key: `${m.__idx}:${m.key}`,
      range: m.range,
      options: {
        color: m.isActive ? ACTIVE_COLOR : COLOR_PER_STAGE[m.stage] ?? COLOR_PER_STAGE[0],
        width: 2,
      },
    }),
    [],
  )

  const indexedMatches = useMemo<IndexedMatch[]>(
    () => matches.map((m, i) => ({ ...m, __idx: i })),
    [matches],
  )

  useOverlayAnnotations<IndexedMatch>(overlayer, {
    namespace: 'vocab',
    items: indexedMatches,
    draw: Overlayer.underline,
    map,
  })

  useOverlayReflow(overlayer, containerRef)

  return (
    <>
      <div
        ref={hostRef}
        aria-hidden="true"
        data-vocab-overlay-host="true"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />
      <VocabTranslationOverlay matches={matches} visible={showInlineTranslations} />
    </>
  )
}
