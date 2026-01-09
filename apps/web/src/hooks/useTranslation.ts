import { useLanguage, SupportedLanguage } from '../context/LanguageContext'
import en from '../locales/en.json'
import uk from '../locales/uk.json'

type TranslationData = typeof en

const translations: Record<SupportedLanguage, TranslationData> = { en, uk }

function getNestedValue(obj: unknown, path: string): unknown {
  const keys = path.split('.')
  let value: unknown = obj
  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = (value as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return value
}

export function useTranslation() {
  const { language } = useLanguage()

  function t(key: string): string {
    const value = getNestedValue(translations[language], key)
    if (typeof value === 'string') return value
    // fallback to EN
    const fallback = getNestedValue(translations.en, key)
    if (typeof fallback === 'string') return fallback
    return key
  }

  function tArray(key: string): string[] {
    const value = getNestedValue(translations[language], key)
    if (Array.isArray(value)) return value as string[]
    // fallback to EN
    const fallback = getNestedValue(translations.en, key)
    if (Array.isArray(fallback)) return fallback as string[]
    return []
  }

  return { t, tArray, language }
}
