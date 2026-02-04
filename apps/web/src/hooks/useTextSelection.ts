import { useState, useEffect, useCallback, useRef } from 'react'

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
  const startPosRef = useRef<{ x: number; y: number } | null>(null)
  const wasDragRef = useRef(false)

  const updateSelection = useCallback(() => {
    // Only show toolbar if user dragged (not double-click)
    if (!wasDragRef.current) {
      return
    }

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
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const pos = 'touches' in e
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : { x: e.clientX, y: e.clientY }
      startPosRef.current = pos
      wasDragRef.current = false
    }

    const handlePointerUp = (e: MouseEvent | TouchEvent) => {
      const endPos = 'changedTouches' in e
        ? { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY }
        : { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY }

      // Check if there was significant movement (drag)
      if (startPosRef.current) {
        const dx = Math.abs(endPos.x - startPosRef.current.x)
        const dy = Math.abs(endPos.y - startPosRef.current.y)
        wasDragRef.current = dx > 10 || dy > 10
      }

      // Small delay to let selection finalize
      setTimeout(updateSelection, 10)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('mouseup', handlePointerUp)
    document.addEventListener('touchstart', handlePointerDown)
    document.addEventListener('touchend', handlePointerUp)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('mouseup', handlePointerUp)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('touchend', handlePointerUp)
    }
  }, [updateSelection])

  return {
    selection,
    clearSelection,
    hasSelection: !selection.isCollapsed && selection.text.length >= minLength,
  }
}
