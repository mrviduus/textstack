import { createContext, useContext, useEffect, useMemo, useCallback, ReactNode } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'

const SUPPORTED_LANGUAGES = ['en', 'uk'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]
const DEFAULT_LANGUAGE: SupportedLanguage = 'en'

interface LanguageContextValue {
  language: SupportedLanguage
  supportedLanguages: readonly string[]
  switchLanguage: (lang: SupportedLanguage) => void
  getLocalizedPath: (path: string) => string
}

const LanguageContext = createContext<LanguageContextValue>({
  language: DEFAULT_LANGUAGE,
  supportedLanguages: SUPPORTED_LANGUAGES,
  switchLanguage: () => {},
  getLocalizedPath: (path) => path,
})

export function LanguageProvider({ children }: { children: ReactNode }) {
  const { lang } = useParams<{ lang: string }>()
  const navigate = useNavigate()
  const location = useLocation()

  const language: SupportedLanguage =
    lang && SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)
      ? (lang as SupportedLanguage)
      : DEFAULT_LANGUAGE

  // Set <html lang> attribute
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  const switchLanguage = useCallback((newLang: SupportedLanguage) => {
    const pathWithoutLang = location.pathname.replace(/^\/(en|uk)/, '')
    const newPath = `/${newLang}${pathWithoutLang || '/'}`
    navigate(newPath.endsWith('/') ? newPath : `${newPath}/`)
  }, [location.pathname, navigate])

  const getLocalizedPath = useCallback((path: string) => {
    if (path.startsWith(`/${language}`)) {
      return path.endsWith('/') ? path : `${path}/`
    }
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    const result = `/${language}${cleanPath}`
    return result.endsWith('/') ? result : `${result}/`
  }, [language])

  const value = useMemo(() => ({
    language,
    supportedLanguages: SUPPORTED_LANGUAGES,
    switchLanguage,
    getLocalizedPath,
  }), [language, switchLanguage, getLocalizedPath])

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  return useContext(LanguageContext)
}

export function isValidLanguage(lang: string | undefined): lang is SupportedLanguage {
  return !!lang && SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)
}
