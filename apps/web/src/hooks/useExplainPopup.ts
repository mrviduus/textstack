import { useState, useCallback, type RefObject } from 'react'
import { useExplain } from './useExplain'
import { extractSentence } from '../lib/sentenceExtractor'
import { tokenizeVocabWords, extractWordFromRange } from '../lib/vocabKey'

interface UseExplainPopupOptions {
  containerRef: RefObject<HTMLElement | null>
  editionId: string
  nativeLanguage: string
  onClose?: () => void
}

export interface UseExplainPopupResult {
  show: boolean
  word: string
  rect: DOMRect | null
  explanation: string | null
  isExplaining: boolean
  error: string | null
  /** `sentence`: the engine's, which hands out no Range; else read from `range`. */
  openFromSelection: (selectionText: string, range: Range | null, rect: DOMRect | null, sentence?: string) => void
  close: () => void
}

export function useExplainPopup({
  containerRef,
  editionId,
  nativeLanguage,
  onClose,
}: UseExplainPopupOptions): UseExplainPopupResult {
  const {
    explanation,
    isLoading: isExplaining,
    error,
    explain: explainApi,
    reset: resetExplain,
  } = useExplain()
  const [show, setShow] = useState(false)
  const [word, setWord] = useState('')
  const [rect, setRect] = useState<DOMRect | null>(null)

  const openFromSelection = useCallback(
    (selectionText: string, range: Range | null, sourceRect: DOMRect | null, engineSentence?: string) => {
      if (!selectionText || (!range && !engineSentence) || !sourceRect) return
      const trimmed = selectionText.trim()
      const isPhrase = /\s/.test(trimmed) && trimmed.length <= 100
      const target = isPhrase
        ? trimmed
        : extractWordFromRange(range)
          ?? tokenizeVocabWords(selectionText)[0]?.word
          ?? trimmed.split(/\s+/)[0]
          ?? trimmed
      if (!target) return
      const sentence = engineSentence
        ?? (range && containerRef.current ? extractSentence(range, containerRef.current) ?? selectionText : selectionText)
      setWord(target)
      setRect(sourceRect)
      setShow(true)
      explainApi({
        word: target,
        sentence,
        bookId: editionId,
        targetLang: nativeLanguage,
      })
    },
    [containerRef, editionId, nativeLanguage, explainApi],
  )

  const close = useCallback(() => {
    setShow(false)
    setWord('')
    setRect(null)
    resetExplain()
    onClose?.()
  }, [resetExplain, onClose])

  return { show, word, rect, explanation, isExplaining, error, openFromSelection, close }
}
