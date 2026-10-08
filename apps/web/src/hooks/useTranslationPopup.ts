import { useState, useCallback } from 'react'
import { useTextTranslation } from './useTextTranslation'
import type { TranslateContext } from '../api/translation'

interface UseTranslationPopupOptions {
  bookLanguage: string
  targetLang: string | null
  onClose?: () => void
}

export interface UseTranslationPopupResult {
  show: boolean
  text: string
  rect: DOMRect | null
  translatedText: string | null
  isTranslating: boolean
  error: string | null
  languages: ReturnType<typeof useTextTranslation>['languages']
  sourceLang: string
  targetLang: string
  /** `ctx` = the sentence the selection sits in (+ book id); kept for lang-switch refetches. */
  open: (text: string, rect: DOMRect | null, ctx?: TranslateContext) => void
  close: () => void
  setSourceLang: (lang: string) => void
  setTargetLang: (lang: string) => void
}

export function useTranslationPopup({
  bookLanguage,
  targetLang,
  onClose,
}: UseTranslationPopupOptions): UseTranslationPopupResult {
  const {
    translatedText,
    isLoading: isTranslating,
    error,
    translate,
    reset: resetTranslation,
    languages,
    sourceLang,
    targetLang: translationTargetLang,
    setSourceLang: setSourceLangApi,
    setTargetLang: setTargetLangApi,
  } = useTextTranslation({
    defaultSourceLang: bookLanguage,
    defaultTargetLang: targetLang,
  })

  const [show, setShow] = useState(false)
  const [text, setText] = useState('')
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [ctx, setCtx] = useState<TranslateContext | undefined>(undefined)

  const open = useCallback(
    (input: string, sourceRect: DOMRect | null, context?: TranslateContext) => {
      const trimmed = input.slice(0, 500)
      setText(trimmed)
      setRect(sourceRect)
      setCtx(context)
      setShow(true)
      translate(trimmed, undefined, undefined, context)
    },
    [translate],
  )

  const close = useCallback(() => {
    setShow(false)
    setText('')
    setRect(null)
    setCtx(undefined)
    resetTranslation()
    onClose?.()
  }, [resetTranslation, onClose])

  const handleSourceLangChange = useCallback(
    (lang: string) => {
      setSourceLangApi(lang)
      if (text) translate(text, lang, translationTargetLang, ctx)
    },
    [setSourceLangApi, translate, text, translationTargetLang, ctx],
  )

  const handleTargetLangChange = useCallback(
    (lang: string) => {
      setTargetLangApi(lang)
      if (text) translate(text, sourceLang, lang, ctx)
    },
    [setTargetLangApi, translate, text, sourceLang, ctx],
  )

  return {
    show,
    text,
    rect,
    translatedText,
    isTranslating,
    error,
    languages,
    sourceLang,
    targetLang: translationTargetLang,
    open,
    close,
    setSourceLang: handleSourceLangChange,
    setTargetLang: handleTargetLangChange,
  }
}
