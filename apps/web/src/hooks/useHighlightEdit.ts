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
  scrollToHighlightId?: string | null
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
  scrollToHl,
  onNavigateToHighlight,
  onAfterCreate,
}: UseHighlightEditOptions): UseHighlightEditResult {
  // Pending post-navigation retry poll for a cross-chapter drawer jump.
  const jumpRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearJumpRetry = useCallback(() => {
    if (jumpRetryTimerRef.current) {
      clearTimeout(jumpRetryTimerRef.current)
      jumpRetryTimerRef.current = null
    }
  }, [])

  // Locate a highlight's text anchor and center it. Returns false when the text
  // isn't in the mounted DOM yet (chapter not rendered / still loading) so the
  // caller can navigate + retry. A located-but-zero-size range counts as done.
  const tryScrollToTarget = useCallback(
    (target: StoredHighlight): boolean => {
      if (!containerRef.current) return false
      const range = findTextByAnchor(target.anchor, containerRef.current, highlightChapterKey(target))
      if (!range) return false
      const rect = range.getBoundingClientRect()
      if (rect.width !== 0 || rect.height !== 0) {
        const targetY = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2
        window.scrollTo({ top: targetY, behavior: 'smooth' })
      }
      return true
    },
    [containerRef],
  )

  // Locate a reflow highlight by its text anchor and center it in the viewport.
  // Shared by the URL-mount one-shot and the drawer's nonce-driven jump. On a
  // miss (the highlight lives in a chapter the reader hasn't mounted) route to
  // that chapter, then poll until its async-loaded DOM contains the anchor.
  const scrollToHighlightById = useCallback(
    (id: string) => {
      const target = highlights.find((h) => h.id === id)
      if (!target || !containerRef.current) return
      clearJumpRetry()
      requestAnimationFrame(() => {
        if (tryScrollToTarget(target)) return
        // PDF anchors jump via the pixel-perfect viewer's page path in
        // ReaderPage, so only reflow highlights should reach the nav fallback.
        if (isPdfAnchor(target.anchor) || !onNavigateToHighlight) return
        onNavigateToHighlight(target)
        let tries = 0
        const retry = () => {
          if (tryScrollToTarget(target) || ++tries >= JUMP_MAX_RETRIES) {
            jumpRetryTimerRef.current = null
            return
          }
          jumpRetryTimerRef.current = setTimeout(retry, JUMP_RETRY_MS)
        }
        jumpRetryTimerRef.current = setTimeout(retry, JUMP_RETRY_MS)
      })
    },
    [highlights, containerRef, onNavigateToHighlight, tryScrollToTarget, clearJumpRetry],
  )

  // Drop any pending retry poll on unmount.
  useEffect(() => clearJumpRetry, [clearJumpRetry])

  // URL deep-link (?highlight=<id>): one-shot on mount once highlights load.
  const scrolledRef = useRef(false)
  useEffect(() => {
    if (!scrollToHighlightId || scrolledRef.current) return
    if (highlights.length === 0 || !containerRef.current) return
    if (!highlights.some((h) => h.id === scrollToHighlightId)) return
    scrolledRef.current = true
    scrollToHighlightById(scrollToHighlightId)
  }, [scrollToHighlightId, highlights, containerRef, scrollToHighlightById])

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
