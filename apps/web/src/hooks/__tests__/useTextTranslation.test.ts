import { describe, it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

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

describe('useTextTranslation — only the latest request is taken (#1269 review)', () => {
  it('translate_AnEarlierAnswerArrivesLate_TheLatestOneStays', async () => {
    const { translate } = await import('../../api/translation')
    const { getCachedTranslation } = await import('../../lib/offlineDb')
    ;(getCachedTranslation as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const answers: Record<string, (v: unknown) => void> = {}
    ;(translate as ReturnType<typeof vi.fn>).mockImplementation((text: string) => new Promise((r) => { answers[text] = r }))
    const { result } = renderHook(() => useTextTranslation({ defaultSourceLang: 'en', defaultTargetLang: 'uk' }))
    let a!: Promise<unknown>, b!: Promise<unknown>
    // Both at the service: the first already asked when the second starts.
    act(() => { a = result.current.translate('first') })
    await waitFor(() => expect(Object.keys(answers)).toEqual(['first']))
    act(() => { b = result.current.translate('second') })
    await waitFor(() => expect(Object.keys(answers)).toEqual(['first', 'second']))
    await act(async () => { answers.second({ translatedText: 'SECOND' }); await b })
    await act(async () => { answers.first({ translatedText: 'FIRST' }); await a })
    expect(result.current.translatedText).toBe('SECOND')
    expect(result.current.isLoading).toBe(false)
  })
})
