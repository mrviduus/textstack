import { useState, useEffect, useCallback } from 'react'
import type { Locator } from '@textstack/reader-engine'
import { mountedEngineFor } from '../lib/readerEngine'

export interface TextSelectionState {
  text: string
  /** Null for an engine selection: the engine never hands out a DOM Range. */
  range: Range | null
  rect: DOMRect | null
  isCollapsed: boolean
  /** Engine selection only (ADR-025): the sentence around it and where it is. */
  sentence?: string
  locator?: Locator
  /** Over the engine's 500 characters: no translate / explain (mobile's SelectionActionBar does the same). */
  tooLong?: boolean
}

const EMPTY_STATE: TextSelectionState = {
  text: '',
  range: null,
  rect: null,
  isCollapsed: true,
}

interface UseTextSelectionOptions {
  minLength?: number
  /**
   * The engine shows the chapter (READER_ENGINE): its `selection` event replaces the DOM listeners.
   * The chapter's slug once its open has landed, null before. Undefined = native selection.
   */
  engineHref?: string | null
}

export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>,
  options?: UseTextSelectionOptions
) {
  const { minLength = 1, engineHref } = options || {}
  const native = engineHref === undefined
  const [selection, setSelection] = useState<TextSelectionState>(EMPTY_STATE)

  const updateSelection = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(EMPTY_STATE)
      return
    }

    const range = sel.getRangeAt(0)
    const text = range.toString().trim()

    // Check if selection is within container
    const container = containerRef.current
    if (!container || !container.contains(range.commonAncestorContainer)) {
      setSelection(EMPTY_STATE)
      return
    }

    // Check min length
    if (text.length < minLength) {
      setSelection(EMPTY_STATE)
      return
    }

    // Get bounding rect
    const rects = range.getClientRects()
    if (rects.length === 0) {
      setSelection(EMPTY_STATE)
      return
    }

    setSelection({
      text,
      range: range.cloneRange(),
      rect: rects[rects.length - 1],
      isCollapsed: false,
    })
  }, [containerRef, minLength])

  const clearSelection = useCallback(() => {
    // The engine forgets it too, or the same word again would be "already sent".
    mountedEngineFor(engineHref ?? undefined)?.engine.clearSelection()
    window.getSelection()?.removeAllRanges()
    setSelection(EMPTY_STATE)
  }, [engineHref])

  useEffect(() => {
    const engine = mountedEngineFor(engineHref ?? undefined)?.engine
    if (!engine) return
    return engine.on('selection', (s) => setSelection(s
      ? { text: s.text, range: null, rect: new DOMRect(s.rect.x, s.rect.y, s.rect.width, s.rect.height), isCollapsed: false, sentence: s.sentence, locator: s.locator, tooLong: s.tooLong }
      : EMPTY_STATE))
  }, [engineHref])

  useEffect(() => {
    if (!native) return
    const handlePointerUp = () => {
      // Small delay to let selection finalize
      setTimeout(updateSelection, 10)
    }

    // selectionchange is more reliable on iOS
    const handleSelectionChange = () => {
      setTimeout(updateSelection, 10)
    }

    document.addEventListener('mouseup', handlePointerUp)
    document.addEventListener('touchend', handlePointerUp)
    document.addEventListener('selectionchange', handleSelectionChange)

    return () => {
      document.removeEventListener('mouseup', handlePointerUp)
      document.removeEventListener('touchend', handlePointerUp)
      document.removeEventListener('selectionchange', handleSelectionChange)
    }
  }, [updateSelection, native])

  return {
    selection,
    clearSelection,
    hasSelection: !selection.isCollapsed && selection.text.length >= minLength,
  }
}
