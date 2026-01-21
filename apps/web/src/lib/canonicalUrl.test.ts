import { describe, it, expect } from 'vitest'
import { buildCanonicalUrl, normalizeOrigin } from './canonicalUrl'

describe('buildCanonicalUrl', () => {
  it('strips utm tracking params', () => {
    const url = buildCanonicalUrl({
      origin: 'https://textstack.app',
      pathname: '/en/books/test',
      search: '?utm_source=google&utm_medium=cpc&utm_campaign=test',
    })
    expect(url).toBe('https://textstack.app/en/books/test')
  })

  it('strips other tracking params', () => {
    const url = buildCanonicalUrl({
      origin: 'https://textstack.app',
      pathname: '/en/search',
      search: '?gclid=123&fbclid=456&_ga=789',
    })
    expect(url).toBe('https://textstack.app/en/search')
  })

  it('preserves semantic param ?q', () => {
    const url = buildCanonicalUrl({
      origin: 'https://textstack.app',
      pathname: '/en/search',
      search: '?q=hello&utm_source=google',
    })
    expect(url).toBe('https://textstack.app/en/search?q=hello')
  })

  it('strips www from origin', () => {
    const url = buildCanonicalUrl({
      origin: 'https://www.textstack.app',
      pathname: '/en/books',
      search: '',
    })
    expect(url).toBe('https://textstack.app/en/books')
  })

  it('forces https', () => {
    const url = buildCanonicalUrl({
      origin: 'http://textstack.app',
      pathname: '/en/books',
      search: '',
    })
    expect(url).toBe('https://textstack.app/en/books')
  })

  it('removes trailing slash from path', () => {
    const url = buildCanonicalUrl({
      origin: 'https://textstack.app',
      pathname: '/en/books/',
      search: '',
    })
    expect(url).toBe('https://textstack.app/en/books')
  })

  it('keeps trailing slash for root path', () => {
    const url = buildCanonicalUrl({
      origin: 'https://textstack.app',
      pathname: '/',
      search: '',
    })
    expect(url).toBe('https://textstack.app/')
  })

  it('handles combined normalization', () => {
    const url = buildCanonicalUrl({
      origin: 'http://www.textstack.app/',
      pathname: '/en/search/',
      search: '?q=test&utm_source=fb&gclid=abc',
    })
    expect(url).toBe('https://textstack.app/en/search?q=test')
  })

  it('handles empty search string', () => {
    const url = buildCanonicalUrl({
      origin: 'https://textstack.app',
      pathname: '/en/books/foo',
    })
    expect(url).toBe('https://textstack.app/en/books/foo')
  })
})

describe('normalizeOrigin', () => {
  it('strips www', () => {
    expect(normalizeOrigin('https://www.textstack.app')).toBe('https://textstack.app')
  })

  it('forces https', () => {
    expect(normalizeOrigin('http://textstack.app')).toBe('https://textstack.app')
  })

  it('adds https if missing', () => {
    expect(normalizeOrigin('textstack.app')).toBe('https://textstack.app')
  })

  it('strips trailing slash', () => {
    expect(normalizeOrigin('https://textstack.app/')).toBe('https://textstack.app')
  })

  it('handles full normalization', () => {
    expect(normalizeOrigin('http://www.textstack.app/')).toBe('https://textstack.app')
  })
})
