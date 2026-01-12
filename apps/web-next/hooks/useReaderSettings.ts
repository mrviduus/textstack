'use client'

import { useState, useEffect, useCallback } from 'react'

export type Theme = 'light' | 'sepia' | 'dark' | 'high-contrast'
export type FontFamily = 'serif' | 'sans' | 'dyslexic'
export type TextAlign = 'left' | 'center' | 'justify'

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
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
  if (typeof window === 'undefined') return defaults
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return { ...defaults, ...JSON.parse(stored) }
  } catch {}
  return defaults
}

function save(settings: ReaderSettings) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function useReaderSettings() {
  const [settings, setSettings] = useState<ReaderSettings>(defaults)
  const [mounted, setMounted] = useState(false)

  // Load settings on mount (client-side only)
  useEffect(() => {
    setSettings(load())
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!mounted) return
    save(settings)
    document.documentElement.dataset.theme = settings.theme
  }, [settings, mounted])

  const update = useCallback((partial: Partial<ReaderSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }))
  }, [])

  const reset = useCallback(() => {
    setSettings(defaults)
  }, [])

  return { settings, update, reset, mounted }
}
