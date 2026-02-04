import { useState, useCallback, useEffect } from 'react'
import { translate as translateApi, getLanguages, type LanguageInfo } from '../api/translation'
import { getCachedTranslation, cacheTranslation, clearOldTranslations } from '../lib/offlineDb'

interface TranslationState {
  translatedText: string | null
  isLoading: boolean
  error: string | null
}

interface UseTextTranslationOptions {
  defaultSourceLang?: string
  defaultTargetLang?: string
}

export function useTextTranslation(options?: UseTextTranslationOptions) {
  const { defaultSourceLang = 'en', defaultTargetLang = 'uk' } = options || {}

  const [state, setState] = useState<TranslationState>({
    translatedText: null,
    isLoading: false,
    error: null,
  })
  const [languages, setLanguages] = useState<LanguageInfo[]>([])
  const [sourceLang, setSourceLang] = useState(defaultSourceLang)
  const [targetLang, setTargetLang] = useState(defaultTargetLang)

  // Fetch available languages on mount
  useEffect(() => {
    let cancelled = false

    getLanguages()
      .then((langs) => {
        if (!cancelled) setLanguages(langs)
      })
      .catch(() => {
        // Use fallback languages if fetch fails
        if (!cancelled) {
          setLanguages([
            { code: 'en', name: 'English' },
            { code: 'uk', name: 'Ukrainian' },
            { code: 'ru', name: 'Russian' },
            { code: 'de', name: 'German' },
            { code: 'fr', name: 'French' },
            { code: 'es', name: 'Spanish' },
            { code: 'pl', name: 'Polish' },
          ])
        }
      })

    // Clear old translations periodically
    clearOldTranslations().catch(() => {})

    return () => {
      cancelled = true
    }
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
