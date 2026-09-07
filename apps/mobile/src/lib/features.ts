// Mobile UI feature flags. Expo exposes env vars prefixed with EXPO_PUBLIC_* at build time.
// Defaults match what users currently see — flip via `EXPO_PUBLIC_*` in EAS secrets / `.env.local`.

import AsyncStorage from '@react-native-async-storage/async-storage'

function readBool(v: unknown, fallback = false): boolean {
  if (typeof v !== 'string') return fallback
  const s = v.trim().toLowerCase()
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false
  return fallback
}

export const FEATURES = {
  // Mobile reader overlay v2 (foliate-js SVG overlayer inside the WebView).
  // Default ON — already shipped to 100% of users via hardcoded `overlayV2: true`.
  // Flip OFF via env if a regression surfaces; per-device override via AsyncStorage below.
  readerOverlayV2: readBool(process.env.EXPO_PUBLIC_READER_OVERLAY_V2, true),

  // Restore the reading position from its text anchor rather than from the pixel
  // offset (ADR-015). Default ON — the anchor is the reason the position survives
  // a font change, and the pixel offset it replaces is still written beside it,
  // so flipping this off falls back to exactly the old behaviour with no data
  // loss. Only the READ is gated; the write never is, so a device that has been
  // switched off keeps accumulating positions for when it is switched back.
  readerTextPosition: readBool(process.env.EXPO_PUBLIC_READER_TEXT_POSITION, true),
} as const

export type FeatureKey = keyof typeof FEATURES

// Per-device override for reader overlay v2. Mirrors web's localStorage cascade
// so support can flip a single user back to legacy without a build:
//   AsyncStorage.setItem('textstack.readerOverlayV2', '0')  // killswitch
//   AsyncStorage.setItem('textstack.readerOverlayV2', '1')  // force on
// Anything else (null / unset) falls back to the build-time default.
export const READER_OVERLAY_V2_STORAGE_KEY = 'textstack.readerOverlayV2'

export function resolveReaderOverlayV2Active(stored: string | null): boolean {
  if (stored === '0') return false
  if (stored === '1') return true
  return FEATURES.readerOverlayV2
}

export async function readReaderOverlayV2Active(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(READER_OVERLAY_V2_STORAGE_KEY)
    return resolveReaderOverlayV2Active(v)
  } catch {
    return FEATURES.readerOverlayV2
  }
}

// Same cascade for the text-anchor restore:
//   AsyncStorage.setItem('textstack.readerTextPosition', '0')  // killswitch
export const READER_TEXT_POSITION_STORAGE_KEY = 'textstack.readerTextPosition'

export function resolveReaderTextPositionActive(stored: string | null): boolean {
  if (stored === '0') return false
  if (stored === '1') return true
  return FEATURES.readerTextPosition
}

export async function readReaderTextPositionActive(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(READER_TEXT_POSITION_STORAGE_KEY)
    return resolveReaderTextPositionActive(v)
  } catch {
    return FEATURES.readerTextPosition
  }
}
