import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  track,
  trackSignUp,
  trackLogin,
  trackBookOpened,
  trackReadingSessionEnd,
  trackVocabSaved,
  trackBookUploaded,
} from './analytics'

// --- Helpers -----------------------------------------------------------

/** Captures gtag invocations so we can assert shapes without coupling to GA4. */
function installGtagSpy() {
  const calls: unknown[][] = []
  ;(window as unknown as { gtag: (...args: unknown[]) => void }).gtag = (...args: unknown[]) => {
    calls.push(args)
  }
  return calls
}

function uninstallGtag() {
  delete (window as unknown as { gtag?: unknown }).gtag
}

describe('analytics.track — safety guarantees', () => {
  afterEach(() => uninstallGtag())

  it('does not throw when gtag is undefined', () => {
    uninstallGtag()
    expect(() => track('sign_up', { method: 'email' })).not.toThrow()
  })

  it('does not throw when gtag throws internally', () => {
    ;(window as unknown as { gtag: (...args: unknown[]) => void }).gtag = () => {
      throw new Error('blocker dropped the call')
    }
    expect(() => track('login', { method: 'google' })).not.toThrow()
  })

  it('forwards event name + params to gtag', () => {
    const calls = installGtagSpy()
    track('book_opened', { source: 'library', edition_id: 'e1' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['event', 'book_opened', { source: 'library', edition_id: 'e1' }])
  })

  it('passes empty object when params omitted', () => {
    const calls = installGtagSpy()
    track('login')
    expect(calls[0]).toEqual(['event', 'login', {}])
  })
})

// --- Convenience wrappers — shape contract tests -----------------------
// Senior intent: pin the wire shape going to GA4. Renames here = silent
// dashboard breakage, so the test catches it before deploy.

describe('trackSignUp', () => {
  beforeEach(() => installGtagSpy())
  afterEach(() => uninstallGtag())

  it('emits sign_up with method', () => {
    const calls = installGtagSpy()
    trackSignUp('apple')
    expect(calls[0]).toEqual(['event', 'sign_up', { method: 'apple' }])
  })
})

describe('trackLogin', () => {
  afterEach(() => uninstallGtag())

  it('emits login with method', () => {
    const calls = installGtagSpy()
    trackLogin('google')
    expect(calls[0]).toEqual(['event', 'login', { method: 'google' }])
  })
})

describe('trackBookOpened', () => {
  afterEach(() => uninstallGtag())

  it('catalog source with editionId', () => {
    const calls = installGtagSpy()
    trackBookOpened({ source: 'library', editionId: 'ed-1', language: 'en' })
    expect(calls[0]).toEqual(['event', 'book_opened', {
      source: 'library',
      edition_id: 'ed-1',
      user_book_id: undefined,
      language: 'en',
    }])
  })

  it('userbook source with userBookId', () => {
    const calls = installGtagSpy()
    trackBookOpened({ source: 'userbook', userBookId: 'ub-1' })
    expect(calls[0]).toEqual(['event', 'book_opened', {
      source: 'userbook',
      edition_id: undefined,
      user_book_id: 'ub-1',
      language: undefined,
    }])
  })

  it('null id fields are normalized to undefined', () => {
    const calls = installGtagSpy()
    trackBookOpened({ source: 'demo', editionId: null, userBookId: null })
    const params = calls[0][2] as Record<string, unknown>
    expect(params.edition_id).toBeUndefined()
    expect(params.user_book_id).toBeUndefined()
  })
})

describe('trackReadingSessionEnd', () => {
  afterEach(() => uninstallGtag())

  it('rounds duration to seconds + computes minutes', () => {
    const calls = installGtagSpy()
    trackReadingSessionEnd({
      durationSeconds: 372.6, wordsRead: 1500,
      startPercent: 0.1234, endPercent: 0.5678,
      editionId: 'ed-1',
    })
    const params = calls[0][2] as Record<string, number | string | undefined>
    expect(params.duration_seconds).toBe(373) // rounded
    expect(params.minutes).toBe(6) // 372.6 / 60 rounded
    expect(params.words_read).toBe(1500)
    expect(params.start_percent).toBe(0.12) // 2 decimals
    expect(params.end_percent).toBe(0.57)
  })

  it('handles zero values', () => {
    const calls = installGtagSpy()
    trackReadingSessionEnd({
      durationSeconds: 0, wordsRead: 0, startPercent: 0, endPercent: 0,
    })
    const params = calls[0][2] as Record<string, number | string | undefined>
    expect(params.duration_seconds).toBe(0)
    expect(params.minutes).toBe(0)
  })
})

describe('trackVocabSaved', () => {
  afterEach(() => uninstallGtag())

  it('includes nativeLanguage when provided', () => {
    const calls = installGtagSpy()
    trackVocabSaved({ language: 'en', nativeLanguage: 'uk', source: 'reader' })
    expect(calls[0][2]).toEqual({ language: 'en', native_language: 'uk', source: 'reader' })
  })

  it('omits nativeLanguage when undefined', () => {
    const calls = installGtagSpy()
    trackVocabSaved({ language: 'en', source: 'manual' })
    const params = calls[0][2] as Record<string, unknown>
    expect(params.native_language).toBeUndefined()
  })
})

describe('trackBookUploaded', () => {
  afterEach(() => uninstallGtag())

  it('computes size_mb to 1 decimal', () => {
    const calls = installGtagSpy()
    trackBookUploaded({ format: 'epub', sizeBytes: 1_572_864 }) // 1.5 MB exact
    const params = calls[0][2] as Record<string, unknown>
    expect(params.format).toBe('epub')
    expect(params.size_bytes).toBe(1_572_864)
    expect(params.size_mb).toBe(1.5)
  })

  it('rounds size_mb correctly', () => {
    const calls = installGtagSpy()
    trackBookUploaded({ format: 'pdf', sizeBytes: 5_242_880 }) // 5.0 MB exact
    expect((calls[0][2] as Record<string, unknown>).size_mb).toBe(5)
  })
})
