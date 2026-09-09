import { useCallback } from 'react'
import { useLanguage, SupportedLanguage } from '../context/LanguageContext'
import { catalog, type TranslationNode } from '../locales/catalog'

// `typeof en` used to stand in for the catalogue's shape. It stopped being able to:
// `en.json` is now an overlay, not the whole thing, and the shared half arrives typed
// as a generic node. The literal type is given up on purpose — nothing consumed it
// structurally (`t(key: string)` and `getNestedValue(obj: unknown)` never did), and
// `missing-keys.test.ts`, which checks every literal `t('…')` against the real
// catalogue, was always the stronger guarantee.
const translations: Record<SupportedLanguage, TranslationNode> = { en: catalog }

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

  // useCallback bound to [language] so t/tArray identities are stable across
  // renders and only change when the language actually changes. Without this,
  // every render returns new fn identities and any consumer using them in
  // useEffect/useCallback deps re-fires on every parent re-render.
  const t = useCallback((key: string, vars?: Record<string, string | number>): string => {
    const value = getNestedValue(translations[language], key)
    const str = typeof value === 'string'
      ? value
      : (typeof getNestedValue(translations.en, key) === 'string'
          ? getNestedValue(translations.en, key) as string
          : key)
    if (!vars) return str
    return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`))
  }, [language])

  const tArray = useCallback((key: string): string[] => {
    const value = getNestedValue(translations[language], key)
    if (Array.isArray(value)) return value as string[]
    const fallback = getNestedValue(translations.en, key)
    if (Array.isArray(fallback)) return fallback as string[]
    return []
  }, [language])

  return { t, tArray, language }
}
