/**
 * Analytics: thin typed wrapper around window.gtag (GA4).
 *
 * - gtag is loaded in apps/web/index.html (+ public/gtag-init.js) with measurement ID G-3ZNR40KDFP.
 * - Safe to call during SSR/prerender — falls back to no-op when window
 *   or gtag is unavailable.
 * - In dev (import.meta.env.DEV) we mirror events to console so you can
 *   verify wiring without waiting for the GA4 realtime report.
 *
 * To mark an event as a Key Event in GA4 Admin → Events, use the exact
 * names below. Do not rename without also updating GA4.
 */

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

/** Allowed event names. Keep in sync with GA4 Key Events config. */
export type AnalyticsEvent =
  | 'sign_up'
  | 'login'
  | 'book_opened'
  | 'reading_session_end'
  | 'vocab_saved'
  | 'book_uploaded'
  | 'translation_used'
  | 'tts_played'
  | 'search_performed'
  | 'landing_cta_click'

type Params = Record<string, string | number | boolean | null | undefined>

const isBrowser = typeof window !== 'undefined'
const isDev =
  typeof import.meta !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).env?.DEV === true

/**
 * Emit a GA4 event. No-op when gtag is unavailable (SSR, bots, blockers).
 * Never throws — analytics must never break the app.
 */
export function track(event: AnalyticsEvent, params?: Params): void {
  try {
    if (isDev) {
      // eslint-disable-next-line no-console
      console.debug('[analytics]', event, params ?? {})
    }
    if (!isBrowser || typeof window.gtag !== 'function') return
    window.gtag('event', event, params ?? {})
  } catch {
    // Swallow — analytics must never break the app.
  }
}

// Convenience wrappers — keep signatures tight so callers can't pass
// arbitrary shapes and drift from GA4's expected params.

export function trackSignUp(method: 'email' | 'google' | 'apple'): void {
  track('sign_up', { method })
}

export function trackLogin(method: 'email' | 'google' | 'apple'): void {
  track('login', { method })
}

export function trackBookOpened(args: {
  source: 'library' | 'userbook' | 'demo'
  editionId?: string | null
  userBookId?: string | null
  language?: string
}): void {
  track('book_opened', {
    source: args.source,
    edition_id: args.editionId ?? undefined,
    user_book_id: args.userBookId ?? undefined,
    language: args.language,
  })
}

export function trackReadingSessionEnd(args: {
  durationSeconds: number
  wordsRead: number
  startPercent: number
  endPercent: number
  editionId?: string | null
  userBookId?: string | null
}): void {
  track('reading_session_end', {
    duration_seconds: Math.round(args.durationSeconds),
    minutes: Math.round(args.durationSeconds / 60),
    words_read: args.wordsRead,
    start_percent: Math.round(args.startPercent * 100) / 100,
    end_percent: Math.round(args.endPercent * 100) / 100,
    edition_id: args.editionId ?? undefined,
    user_book_id: args.userBookId ?? undefined,
  })
}

export function trackVocabSaved(args: {
  language: string
  nativeLanguage?: string
  source: 'reader' | 'manual'
}): void {
  track('vocab_saved', {
    language: args.language,
    native_language: args.nativeLanguage,
    source: args.source,
  })
}

export function trackBookUploaded(args: {
  format: string
  sizeBytes: number
}): void {
  track('book_uploaded', {
    format: args.format,
    size_bytes: args.sizeBytes,
    size_mb: Math.round((args.sizeBytes / 1024 / 1024) * 10) / 10,
  })
}

export function trackTranslationUsed(args: {
  fromLang: string
  toLang: string
  kind: 'word' | 'selection'
}): void {
  track('translation_used', {
    from_lang: args.fromLang,
    to_lang: args.toLang,
    kind: args.kind,
  })
}

export function trackTtsPlayed(args: {
  language: string
  kind: 'word' | 'sentence' | 'selection'
}): void {
  track('tts_played', { language: args.language, kind: args.kind })
}

export function trackSearchPerformed(args: {
  query: string
  resultsCount?: number
}): void {
  track('search_performed', {
    // Truncate to keep cardinality bounded.
    query: args.query.slice(0, 100),
    results_count: args.resultsCount,
  })
}

export function trackLandingCtaClick(args: {
  page: string
  label: string
}): void {
  track('landing_cta_click', { page: args.page, label: args.label })
}
