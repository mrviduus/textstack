import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

// Offline DB touches IndexedDB on mount (clearOldTranslations) — stub it out.
vi.mock('../../lib/offlineDb', () => ({
  getCachedTranslation: vi.fn(),
  cacheTranslation: vi.fn(),
  clearOldTranslations: vi.fn(() => Promise.resolve()),
}))

// Ensure the hook does NOT call the backend languages endpoint anymore.
// Rest-param signature so the passthrough spread type-checks; the closure keeps
// access lazy (vi.mock factories are hoisted above this declaration).
const getLanguages = vi.fn((..._a: unknown[]) => Promise.reject(new Error('should not be called')))
vi.mock('../../api/translation', () => ({
  translate: vi.fn(),
  getLanguages: (...args: unknown[]) => getLanguages(...args),
}))

import { useTextTranslation } from '../useTextTranslation'
import { LANGUAGES } from '@textstack/shared'

describe('useTextTranslation — language catalogue', () => {
  it('maps the full LANGUAGES catalogue to {code,name} synchronously', () => {
    const { result } = renderHook(() => useTextTranslation({ defaultSourceLang: 'en' }))

    // Full catalogue, not the legacy 16-item backend list.
    expect(result.current.languages).toHaveLength(LANGUAGES.length)
    expect(LANGUAGES.length).toBeGreaterThan(16)

    // Shape is {code, name} using englishName for the label.
    const en = result.current.languages.find((l) => l.code === 'en')
    expect(en).toEqual({ code: 'en', name: 'English' })
  })

  it('includes languages beyond the old 16-item cap', () => {
    const { result } = renderHook(() => useTextTranslation({ defaultSourceLang: 'en' }))
    const codes = result.current.languages.map((l) => l.code)
    // Swahili / Welsh / Vietnamese were absent from the legacy backend list.
    expect(codes).toContain('sw')
    expect(codes).toContain('cy')
    expect(codes).toContain('vi')
  })

  it('does not fetch languages from the backend', () => {
    renderHook(() => useTextTranslation({ defaultSourceLang: 'en' }))
    expect(getLanguages).not.toHaveBeenCalled()
  })

  it('honors default source/target langs', () => {
    const { result } = renderHook(() =>
      useTextTranslation({ defaultSourceLang: 'de', defaultTargetLang: 'uk' }),
    )
    expect(result.current.sourceLang).toBe('de')
    expect(result.current.targetLang).toBe('uk')
  })
})
