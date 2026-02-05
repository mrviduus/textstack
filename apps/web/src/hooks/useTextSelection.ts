import { useState, useEffect, useCallback } from 'react'

export interface TextSelectionState {
  text: string
  range: Range | null
  rect: DOMRect | null
  isCollapsed: boolean
}

const EMPTY_STATE: TextSelectionState = {
  text: '',
  range: null,
  rect: null,
  isCollapsed: true,
}

interface UseTextSelectionOptions {
  minLength?: number
}

export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>,
  options?: UseTextSelectionOptions
) {
  const { minLength = 1 } = options || {}
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
    window.getSelection()?.removeAllRanges()
    setSelection(EMPTY_STATE)
  }, [])

  useEffect(() => {
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
  }, [updateSelection])

  return {
    selection,
    clearSelection,
    hasSelection: !selection.isCollapsed && selection.text.length >= minLength,
  }
}
