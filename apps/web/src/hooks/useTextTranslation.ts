import { useState, useCallback, useEffect, useMemo } from 'react'
import { translate as translateApi, type LanguageInfo } from '../api/translation'
import { LANGUAGES } from '@textstack/shared'
import { getCachedTranslation, cacheTranslation, clearOldTranslations } from '../lib/offlineDb'

// Full native-language catalogue → the {code,name} shape TranslationPopup's
// <select> renders. OpenAI translates any language, so the reader is no longer
// capped at the backend's legacy 16-item /translate/languages list (that
// endpoint stays live but unused). englishName matches the popup's label render
// (a native <select> can't show flags).
const TRANSLATION_LANGUAGES: LanguageInfo[] = LANGUAGES.map((l) => ({
  code: l.code,
  name: l.englishName,
}))

interface TranslationState {
  translatedText: string | null
  isLoading: boolean
  error: string | null
}

interface UseTextTranslationOptions {
  defaultSourceLang?: string
  defaultTargetLang?: string | null
}

export function useTextTranslation(options?: UseTextTranslationOptions) {
  const { defaultSourceLang = 'en', defaultTargetLang } = options || {}

  const [state, setState] = useState<TranslationState>({
    translatedText: null,
    isLoading: false,
    error: null,
  })
  // Language list is now synchronous from the full catalogue — no fetch.
  const languages = useMemo<LanguageInfo[]>(() => TRANSLATION_LANGUAGES, [])
  const [sourceLang, setSourceLang] = useState(defaultSourceLang)
  const [targetLang, setTargetLang] = useState(defaultTargetLang || defaultSourceLang)

  // Clear old cached translations periodically.
  useEffect(() => {
    clearOldTranslations().catch(() => {})
  }, [])

  const translate = useCallback(
    async (text: string, source?: string, target?: string) => {
      const srcLang = source || sourceLang
      const tgtLang = target || targetLang

      setState({ translatedText: null, isLoading: true, error: null })

      // Check cache first
      try {
        const cached = await getCachedTranslation(srcLang, tgtLang, text)
        if (cached) {
          setState({
            translatedText: cached.translatedText,
            isLoading: false,
            error: null,
          })
          return cached.translatedText
        }
      } catch {
        // Cache read failed, continue with API call
      }

      // Check if offline
      if (!navigator.onLine) {
        setState({
          translatedText: null,
          isLoading: false,
          error: 'Translation unavailable offline',
        })
        return null
      }

      try {
        const result = await translateApi(text, srcLang, tgtLang)

        // Cache the result
        try {
          await cacheTranslation(srcLang, tgtLang, text, result.translatedText)
        } catch {
          // Cache write failed, continue
        }

        setState({
          translatedText: result.translatedText,
          isLoading: false,
          error: null,
        })

        return result.translatedText
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Translation failed'
        setState({
          translatedText: null,
          isLoading: false,
          error,
        })
        return null
      }
    },
    [sourceLang, targetLang]
  )

  const reset = useCallback(() => {
    setState({
      translatedText: null,
      isLoading: false,
      error: null,
    })
  }, [])

  return {
    ...state,
    translate,
    reset,
    languages,
    sourceLang,
    targetLang,
    setSourceLang,
    setTargetLang,
  }
}
