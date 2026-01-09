import { useState, useEffect, useCallback } from 'react'

export type Theme = 'light' | 'sepia' | 'dark' | 'high-contrast'
export type FontFamily = 'serif' | 'sans' | 'dyslexic'
export type TextAlign = 'left' | 'center' | 'justify'

export interface ReaderSettings {
  fontSize: number // 16-26
  lineHeight: number // 1.5, 1.65, 1.8
  textAlign: TextAlign
  theme: Theme
  fontFamily: FontFamily
}

const STORAGE_KEY = 'reader.settings.v1'

const defaults: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.65,
  textAlign: 'left',
  theme: 'light',
  fontFamily: 'serif',
}

function load(): ReaderSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return { ...defaults, ...JSON.parse(stored) }
  } catch {}
  return defaults
}

function save(settings: ReaderSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function useReaderSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(load)

  useEffect(() => {
    save(settings)
    // Apply theme to html element
    document.documentElement.dataset.theme = settings.theme
  }, [settings])

  const update = useCallback((partial: Partial<ReaderSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }))
  }, [])

  const reset = useCallback(() => {
    setSettings(defaults)
  }, [])

  return { settings, update, reset }
}
