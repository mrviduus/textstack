import { useState, useEffect, useCallback, useRef, type RefObject } from 'react'
import { isPdfAnchor } from '@textstack/shared'
import { findTextByAnchor, createTextAnchor, highlightChapterKey, isCacheChapterKey } from '../lib/textAnchor'
import type { HighlightAnchor, HighlightColor, StoredHighlight } from '../lib/offlineDb'

/** Repeatable drawer jump: same id re-fires when the nonce changes. */
export interface ScrollToHighlight {
  id: string
  nonce: number
}

// The web reflow reader renders ONE chapter at a time, so a drawer jump to a
// highlight in a not-mounted chapter can't be located immediately. After
// navigating to its chapter we poll until its async-loaded DOM contains the
// anchor (mirrors the ?highlight= URL mount-jump), then land the scroll.
const JUMP_RETRY_MS = 120
const JUMP_MAX_RETRIES = 40

interface UseHighlightEditOptions {
  // Highlights + mutators are hoisted to ReaderPage and passed in, so the reader
  // owns a single useHighlights instance (shared with the PDF paint path).
  highlights: StoredHighlight[]
  addHighlight: (anchor: HighlightAnchor, color: HighlightColor, selectedText: string) => Promise<StoredHighlight>
  updateHighlight: (id: string, updates: { color?: HighlightColor; noteText?: string | null }) => Promise<StoredHighlight | null>
  removeHighlight: (id: string) => Promise<void>
  chapterId: string
  containerRef: RefObject<HTMLElement | null>
  /** `?highlight=<id>` from the URL (live: a drawer jump to another chapter adds it). */
  scrollToHighlightId?: string | null
  /** Highlights and the chapter are loaded: the link may be resolved now. */
  highlightLinkReady?: boolean
  /**
   * The link landed (true) or cannot (false: no such highlight, or its text never
   * appeared). The reader then drops the param and, on false, runs its normal restore.
   */
  onHighlightLinkDone?: (found: boolean) => void
  /** The Original-layout PDF viewer is up and page-jumps to a PDF highlight. */
  pdfLinkJumps?: boolean
  /** Nonce-driven jump from the TOC drawer's Highlights tab (reflow only). */
  scrollToHl?: ScrollToHighlight | null
  /**
   * Route to a reflow highlight's chapter when a drawer jump misses (its chapter
   * isn't the mounted one). The web reader renders one chapter at a time, so the
   * book-wide drawer list can target an off-screen chapter — without this the tap
   * is a dead no-op. Called only on a reflow miss; PDF jumps never reach here.
   */
  onNavigateToHighlight?: (highlight: StoredHighlight) => void
  onAfterCreate?: () => void
}

export interface UseHighlightEditResult {
  highlights: StoredHighlight[]
  editingHighlight: StoredHighlight | null
  editingRect: DOMRect | null
  handleHighlightClick: (highlight: StoredHighlight, rect: DOMRect) => void
  closeNoteEditor: () => void
  handleNoteSave: (noteText: string | null) => Promise<void>
  handleHighlightDelete: () => Promise<void>
  createHighlightFromSelection: (
    range: Range | null,
    text: string,
    color: HighlightColor,
  ) => Promise<void>
}

export function useHighlightEdit({
  highlights,
  addHighlight,
  updateHighlight,
  removeHighlight,
  chapterId,
  containerRef,
  scrollToHighlightId,
  highlightLinkReady = false,
  onHighlightLinkDone,
  pdfLinkJumps = false,
  scrollToHl,
  onNavigateToHighlight,
  onAfterCreate,
}: UseHighlightEditOptions): UseHighlightEditResult {

  // Locate a highlight's text anchor and center it. Returns false when the text
  // isn't in the mounted DOM yet (chapter not rendered / still loading) so the
  // caller can navigate + retry. A located-but-zero-size range counts as done.
  const tryScrollToTarget = useCallback(
    (target: StoredHighlight, behavior: ScrollBehavior = 'smooth'): boolean => {
      if (!containerRef.current) return false
      const range = findTextByAnchor(target.anchor, containerRef.current, highlightChapterKey(target))
      if (!range) return false
      const rect = range.getBoundingClientRect()
      if (rect.width !== 0 || rect.height !== 0) {
        const targetY = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2
        window.scrollTo({ top: targetY, behavior })
      }
      return true
    },
    [containerRef],
  )

  // Drawer jump: center a highlight in the mounted chapter. On a miss (its
  // chapter is not the mounted one) route there — the route carries
  // ?highlight=<id>, which the link effect below resolves.
  const scrollToHighlightById = useCallback(
    (id: string) => {
      const target = highlights.find((h) => h.id === id)
      if (!target || !containerRef.current) return
      requestAnimationFrame(() => {
        if (tryScrollToTarget(target)) return
        // PDF anchors jump via the pixel-perfect viewer's page path in
        // ReaderPage, so only reflow highlights should reach the nav fallback.
        if (isPdfAnchor(target.anchor) || !onNavigateToHighlight) return
        onNavigateToHighlight(target)
      })
    },
    [highlights, containerRef, onNavigateToHighlight, tryScrollToTarget],
  )

  // ?highlight=<id>: once highlights and the chapter are loaded, land on it
  // (instant, so the reader is positioned before anything saves) and report the
  // outcome either way — the reader holds its restore until then.
  const onLinkDoneRef = useRef(onHighlightLinkDone)
  onLinkDoneRef.current = onHighlightLinkDone
  const highlightsRef = useRef(highlights)
  highlightsRef.current = highlights
  useEffect(() => {
    if (!scrollToHighlightId || !highlightLinkReady) return
    const target = highlightsRef.current.find((h) => h.id === scrollToHighlightId)
    if (!target) {
      onLinkDoneRef.current?.(false)
      return
    }
    // A PDF highlight is positioned by ReaderPage's page jump — only in Original
    // layout. In reflow (the PDF fell back to text) nothing would move, and
    // "landed" would let save-on-open record wherever the reader happens to be.
    if (isPdfAnchor(target.anchor)) {
      onLinkDoneRef.current?.(pdfLinkJumps)
      return
    }
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = () => {
      if (tryScrollToTarget(target, 'instant')) onLinkDoneRef.current?.(true)
      else if (++tries >= JUMP_MAX_RETRIES) onLinkDoneRef.current?.(false)
      else timer = setTimeout(attempt, JUMP_RETRY_MS)
    }
    attempt()
    return () => clearTimeout(timer)
  }, [scrollToHighlightId, highlightLinkReady, pdfLinkJumps, tryScrollToTarget])

  // Drawer jump: nonce-driven so re-selecting the same highlight re-fires.
  const lastNonceRef = useRef<number | null>(null)
  useEffect(() => {
    if (!scrollToHl) return
    if (lastNonceRef.current === scrollToHl.nonce) return
    lastNonceRef.current = scrollToHl.nonce
    scrollToHighlightById(scrollToHl.id)
  }, [scrollToHl, scrollToHighlightById])

  const [editingHighlight, setEditingHighlight] = useState<StoredHighlight | null>(null)
  const [editingRect, setEditingRect] = useState<DOMRect | null>(null)

  const handleHighlightClick = useCallback(
    (highlight: StoredHighlight, rect: DOMRect) => {
      setEditingHighlight(highlight)
      setEditingRect(rect)
    },
    [],
  )

  const closeNoteEditor = useCallback(() => {
    setEditingHighlight(null)
    setEditingRect(null)
  }, [])

  const handleNoteSave = useCallback(
    async (noteText: string | null) => {
      if (editingHighlight) await updateHighlight(editingHighlight.id, { noteText })
    },
    [editingHighlight, updateHighlight],
  )

  const handleHighlightDelete = useCallback(async () => {
    if (!editingHighlight) return
    await removeHighlight(editingHighlight.id)
    closeNoteEditor()
  }, [editingHighlight, removeHighlight, closeNoteEditor])

  const createHighlightFromSelection = useCallback(
    async (range: Range | null, text: string, color: HighlightColor) => {
      if (!range || !containerRef.current) return
      const anchor = createTextAnchor(range, chapterId, containerRef.current)
      // An old offline-cache chapter whose real id is unknown: the server would
      // reject the cache key, and the row could never sync. Not saved.
      // ponytail: blocked, not queued — only an offline read of a pre-fix cache row hits it.
      if (isCacheChapterKey(anchor.chapterId)) return
      await addHighlight(anchor, color, text)
      onAfterCreate?.()
    },
    [containerRef, chapterId, addHighlight, onAfterCreate],
  )

  return {
    highlights,
    editingHighlight,
    editingRect,
    handleHighlightClick,
    closeNoteEditor,
    handleNoteSave,
    handleHighlightDelete,
    createHighlightFromSelection,
  }
}
