import { useState, useCallback } from 'react'
import { useExplain } from './useExplain'
import { tokenizeVocabWords } from '../lib/vocabKey'

interface UseExplainPopupOptions {
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
  /** `sentence`: the engine's, around the selection; the selection itself when missing. */
  openFromSelection: (selectionText: string, rect: DOMRect | null, sentence?: string) => void
  close: () => void
}

export function useExplainPopup({
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
    (selectionText: string, sourceRect: DOMRect | null, sentence?: string) => {
      if (!selectionText || !sourceRect) return
      const trimmed = selectionText.trim()
      const isPhrase = /\s/.test(trimmed) && trimmed.length <= 100
      const target = isPhrase
        ? trimmed
        : tokenizeVocabWords(selectionText)[0]?.word
          ?? trimmed.split(/\s+/)[0]
          ?? trimmed
      if (!target) return
      setWord(target)
      setRect(sourceRect)
      setShow(true)
      explainApi({
        word: target,
        sentence: sentence || selectionText,   // no sentence from the engine: never fail silently
        bookId: editionId,
        targetLang: nativeLanguage,
      })
    },
    [editionId, nativeLanguage, explainApi],
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
