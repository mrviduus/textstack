import { useState, useEffect, useCallback, useRef } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

export interface ReaderSettings {
  fontSize: number
  lineHeight: number
  fontFamily: 'serif' | 'sans' | 'dyslexic'
  textAlign: 'left' | 'center' | 'justify'
  theme: 'light' | 'sepia' | 'dark'
  ttsSpeed: number
  /**
   * "Auto-save words on tap" toggle. Historical name — was "auto-open
   * dictionary on tap" before the Free Dictionary API was dropped from
   * mobile (2026-05-15). Field name kept for persisted-settings
   * back-compat; UI label updated.
   */
  autoLookup: boolean
  showReaderStats: boolean
  showInlineTranslations: boolean
  /** Last color picked when creating a highlight. The SelectionActionBar
   *  uses a single highlight button (no inline palette) — first tap commits
   *  this color, and changing the color happens via HighlightNoteModal. */
  lastHighlightColor: 'yellow' | 'green' | 'pink' | 'blue'
}

const STORAGE_KEY = 'reader.settings.v2'
const LEGACY_KEY = 'reader.settings.v1'

/**
 * What is stored is what the reader CHOSE — not the whole settings object.
 *
 * The old shape wrote all ten keys on every change, so adjusting the font size froze every other
 * setting at whatever the defaults happened to be that day. Then `{...defaults, ...stored}` read
 * them all back as decisions. The two cases are byte-identical in storage: "the reader picked
 * left" and "left was the default when this device first saved anything". A changed default could
 * therefore never reach anyone who had ever touched any setting — which is exactly what happened
 * when the reader's text alignment default moved to centre and no device saw it.
 *
 * Storing only the touched keys keeps both promises: a new default reaches everyone who never
 * expressed an opinion, and never overrides anyone who did.
 */
type StoredSettings = Partial<ReaderSettings>

const defaults: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.65,
  fontFamily: 'serif',
  // Owner's call, and it also ends a disagreement: web has defaulted to
  // 'center' since it shipped, so the two clients now open a book the same way.
  // Existing readers keep whatever they chose — this is the default for a fresh
  // install, and the setting has three options in the drawer.
  textAlign: 'center',
  theme: 'light',
  ttsSpeed: 1.0,
  autoLookup: false,
  showReaderStats: true,
  showInlineTranslations: true,
  lastHighlightColor: 'yellow',
}

const fontFamilyMap: Record<string, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  dyslexic: '"OpenDyslexic", sans-serif',
}

export const themeStyles = {
  light: { backgroundColor: '#FFFFFF', textColor: '#111827' },
  sepia: { backgroundColor: '#F4ECD8', textColor: '#433422' },
  dark: { backgroundColor: '#1A1A2E', textColor: '#E0E0E0' },
}

/** The last settings any reader screen held, for this app run. ‹ / › remount the reader, and a
 *  mount that starts from the defaults while AsyncStorage answers builds the next chapter Light, in
 *  the default font — the flash on Prev, and the lost Dark theme. Storage stays the source of truth. */
let lastKnown: { settings: ReaderSettings; chosen: StoredSettings } | null = null

export function useReaderSettings() {
  const [settings, setSettingsState] = useState<ReaderSettings>(() => lastKnown?.settings ?? defaults)
  // The reader's actual choices, which is all that goes to storage.
  const chosenRef = useRef<StoredSettings>(lastKnown?.chosen ?? {})
  const setSettings = useCallback((next: ReaderSettings | ((prev: ReaderSettings) => ReaderSettings)) => {
    setSettingsState(prev => {
      const value = typeof next === 'function' ? next(prev) : next
      lastKnown = { settings: value, chosen: chosenRef.current }
      return value
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    AsyncStorage.getItem(STORAGE_KEY).then(async raw => {
      if (cancelled) return
      if (raw) {
        try {
          const stored = JSON.parse(raw) as StoredSettings
          chosenRef.current = stored
          setSettings({ ...defaults, ...stored })
        } catch {}
        return
      }
      // Migrate from v1
      const legacy = await AsyncStorage.getItem(LEGACY_KEY)
      if (cancelled) return
      if (legacy) {
        try {
          // v1 spelled the sans family 'system'; parsed loosely because the old shape is not
          // assignable to the current one, which is the whole reason the rename exists.
          const old = JSON.parse(legacy) as Omit<StoredSettings, 'fontFamily'> & { fontFamily?: string }
          if (old.fontFamily === 'system') old.fontFamily = 'sans'
          // Carried over as choices, because that is what they were on v1 — and because there is
          // no provenance to recover. The same is true of anything already written under v2: a
          // device that has settings keeps them, and only future default changes benefit.
          const chosen = old as StoredSettings
          chosenRef.current = chosen
          setSettings({ ...defaults, ...chosen })
          AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(chosen))
          AsyncStorage.removeItem(LEGACY_KEY)
        } catch {}
      }
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [setSettings])

  const update = useCallback((patch: Partial<ReaderSettings>) => {
    // Only what was touched, ever. `prev` is the fully-merged object, so serialising it is what
    // turned defaults into decisions.
    chosenRef.current = { ...chosenRef.current, ...patch }
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(chosenRef.current)).catch(() => {})
    setSettings(prev => ({ ...prev, ...patch }))
  }, [setSettings])

  const resolvedFontFamily = fontFamilyMap[settings.fontFamily] || fontFamilyMap.serif
  const resolvedTheme = themeStyles[settings.theme]

  return {
    settings,
    update,
    resolvedFontFamily,
    resolvedTheme,
  }
}
