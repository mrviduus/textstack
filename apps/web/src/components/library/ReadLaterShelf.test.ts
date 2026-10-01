import { describe, it, expect } from 'vitest'
import { cardState, sourceDomain, estReadMinutes, isHttpUrl } from './ReadLaterShelf'
import type { UserBook } from '../../api/userBooks'

function book(overrides: Partial<UserBook> = {}): UserBook {
  return {
    id: 'b1',
    title: 'T',
    slug: 's',
    language: 'en',
    author: null,
    description: null,
    coverPath: null,
    genre: null,
    status: 'Ready',
    errorMessage: null,
    chapterCount: 1,
    totalWordCount: 0,
    createdAt: '2026-06-01T00:00:00Z',
    completedAt: null,
    progressPercent: null,
    progressUpdatedAt: null,
    progressChapterSlug: null,
    sourceUrl: null,
    isClip: true,
    isRead: false,
    readAt: null,
    ...overrides,
  }
}

describe('cardState', () => {
  it('Processing wins over everything', () => {
    expect(cardState(book({ status: 'Processing', isRead: true, progressPercent: 0.5 })))
      .toEqual({ kind: 'processing' })
  })

  it('Failed status', () => {
    expect(cardState(book({ status: 'Failed' }))).toEqual({ kind: 'failed' })
  })

  it('Read when isRead true', () => {
    expect(cardState(book({ isRead: true, progressPercent: 0.4 }))).toEqual({ kind: 'read' })
  })

  it('inProgress with rounded percent', () => {
    expect(cardState(book({ progressPercent: 0.604 }))).toEqual({ kind: 'inProgress', percent: 60 })
  })

  it('New when unread and no progress', () => {
    expect(cardState(book({ progressPercent: 0 }))).toEqual({ kind: 'new' })
    expect(cardState(book({ progressPercent: null }))).toEqual({ kind: 'new' })
  })
})

describe('sourceDomain', () => {
  it('strips www', () => {
    expect(sourceDomain('https://www.anthropic.com/x')).toBe('anthropic.com')
  })
  it('keeps subdomains', () => {
    expect(sourceDomain('https://blog.example.com/p')).toBe('blog.example.com')
  })
  it('null on missing/garbage', () => {
    expect(sourceDomain(null)).toBeNull()
    expect(sourceDomain('not a url')).toBeNull()
  })
})

describe('estReadMinutes', () => {
  it('personal pace else ~200 wpm, floored at 1', () => {
    expect(estReadMinutes(2400)).toBe(12)
    expect(estReadMinutes(0)).toBe(1)
    expect(estReadMinutes(null)).toBe(1)
    expect(estReadMinutes(2400, 300)).toBe(8)
  })
})

describe('isHttpUrl', () => {
  it('accepts http(s) only', () => {
    expect(isHttpUrl('https://x.com')).toBe(true)
    expect(isHttpUrl('http://x.com')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl(null)).toBe(false)
  })
})
