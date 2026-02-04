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
  debounceMs?: number
}

export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>,
  options?: UseTextSelectionOptions
) {
  const { minLength = 1, debounceMs = 100 } = options || {}
  const [selection, setSelection] = useState<TextSelectionState>(EMPTY_STATE)
  const debounceRef = useRef<number | null>(null)
  const startPosRef = useRef<{ x: number; y: number } | null>(null)
  const wasDragRef = useRef(false)

  const updateSelection = useCallback((requireDrag = false) => {
    // If requireDrag is true and there was no drag, don't show toolbar
    if (requireDrag && !wasDragRef.current) {
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
    if (!container) {
      setSelection(EMPTY_STATE)
      return
    }

    const commonAncestor = range.commonAncestorContainer
    if (!container.contains(commonAncestor)) {
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

    // Use the last rect for positioning (end of selection)
    const lastRect = rects[rects.length - 1]

    setSelection({
      text,
      range: range.cloneRange(),
      rect: lastRect,
      isCollapsed: false,
    })
  }, [containerRef, minLength])

  const clearSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges()
    setSelection(EMPTY_STATE)
  }, [])

  useEffect(() => {
    const handleSelectionChange = () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }

      debounceRef.current = window.setTimeout(() => {
        // Don't update on selectionchange - wait for mouseup/touchend
        debounceRef.current = null
      }, debounceMs)
    }

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

      // Small delay to let selection finalize, require drag
      setTimeout(() => updateSelection(true), 10)
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('mouseup', handlePointerUp)
    document.addEventListener('touchstart', handlePointerDown)
    document.addEventListener('touchend', handlePointerUp)

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('mouseup', handlePointerUp)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('touchend', handlePointerUp)
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [updateSelection, debounceMs])

  return {
    selection,
    clearSelection,
    hasSelection: !selection.isCollapsed && selection.text.length >= minLength,
  }
}
