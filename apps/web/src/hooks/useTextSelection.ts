import { useState, useEffect, useCallback } from 'react'
import type { Locator } from '@textstack/reader-engine'
import { mountedEngineFor } from '../lib/readerEngine'

export interface TextSelectionState {
  text: string
  rect: DOMRect | null
  isCollapsed: boolean
  /** The sentence around it and where it is (the engine's selection, ADR-025). */
  sentence?: string
  locator?: Locator
  /** Over the engine's 500 characters: no translate / explain (mobile's SelectionActionBar does the same). */
  tooLong?: boolean
}

const EMPTY_STATE: TextSelectionState = {
  text: '',
  rect: null,
  isCollapsed: true,
}

/**
 * The engine's `selection` event (ADR-025). `engineHref`: the chapter's slug (or the PDF engine's slot)
 * once its open has landed, null before.
 */
export function useTextSelection(engineHref: string | null) {
  const [selection, setSelection] = useState<TextSelectionState>(EMPTY_STATE)

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
      ? { text: s.text, rect: new DOMRect(s.rect.x, s.rect.y, s.rect.width, s.rect.height), isCollapsed: false, sentence: s.sentence, locator: s.locator, tooLong: s.tooLong }
      : EMPTY_STATE))
  }, [engineHref])

  return {
    selection,
    clearSelection,
    hasSelection: !selection.isCollapsed && selection.text.length >= 1,
  }
}
