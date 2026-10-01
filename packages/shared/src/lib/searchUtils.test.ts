import { describe, it, expect } from 'vitest'
import { matchesQuery, normalizeForSearch, parseQuery } from './searchUtils'

describe('normalizeForSearch', () => {
  it('strips diacritics + lowercases', () => {
    expect(normalizeForSearch('Tolstoï')).toBe('tolstoi')
    expect(normalizeForSearch('Frankenštein')).toBe('frankenstein')
    // Cyrillic "й" decomposes to "и" + combining breve — accepted for substring lenience
    expect(normalizeForSearch('Война и мир')).toBe('воина и мир')
  })
  it('handles null/undefined safely', () => {
    expect(normalizeForSearch(null)).toBe('')
    expect(normalizeForSearch(undefined)).toBe('')
  })
})

describe('matchesQuery', () => {
  const book = { title: 'Война и мир', author: 'Лев Толстой' }

  it('empty query matches everything', () => {
    expect(matchesQuery(book, '')).toBe(true)
    expect(matchesQuery(book, '   ')).toBe(true)
  })
  it('case-insensitive substring on title', () => {
    expect(matchesQuery({ title: 'War and Peace', author: null }, 'war')).toBe(true)
    expect(matchesQuery({ title: 'War and Peace', author: null }, 'WAR')).toBe(true)
  })
  it('substring on author', () => {
    expect(matchesQuery({ title: 'Hadji Murat', author: 'Leo Tolstoy' }, 'tolstoy')).toBe(true)
  })
  it('diacritics insensitive', () => {
    expect(matchesQuery({ title: 'Tolstoï', author: null }, 'tolstoi')).toBe(true)
    expect(matchesQuery({ title: 'Frankenstein', author: null }, 'Frankenštein')).toBe(true)
  })
  it('multi-word query: all terms must match', () => {
    expect(matchesQuery({ title: 'War and Peace', author: 'Tolstoy' }, 'war tolstoy')).toBe(true)
    expect(matchesQuery({ title: 'War and Peace', author: 'Tolstoy' }, 'war dickens')).toBe(false)
  })
  it('null fields handled', () => {
    expect(matchesQuery({ title: null, author: null }, 'foo')).toBe(false)
    expect(matchesQuery({ title: null, author: 'Tolstoy' }, 'tolstoy')).toBe(true)
  })
})

describe('parseQuery', () => {
  it('extracts tag tokens and remaining text', () => {
    expect(parseQuery('tag:fantasy tolkien')).toEqual({ tags: ['fantasy'], text: 'tolkien' })
  })
  it('handles multiple tag tokens', () => {
    expect(parseQuery('tag:fantasy tag:2026')).toEqual({ tags: ['fantasy', '2026'], text: '' })
  })
  it('lowercases tag values and strips empties', () => {
    expect(parseQuery('TAG:FOO bar')).toEqual({ tags: ['foo'], text: 'bar' })
  })
  it('returns empty arrays for plain text', () => {
    expect(parseQuery('war and peace')).toEqual({ tags: [], text: 'war and peace' })
  })
})

describe('matchesQuery with tags', () => {
  const book = { title: 'Lord of the Rings', author: 'Tolkien', tags: ['fantasy', 'classic'] }

  it('tag: filter requires presence', () => {
    expect(matchesQuery(book, 'tag:fantasy')).toBe(true)
    expect(matchesQuery(book, 'tag:scifi')).toBe(false)
  })
  it('multiple tag: tokens are AND', () => {
    expect(matchesQuery(book, 'tag:fantasy tag:classic')).toBe(true)
    expect(matchesQuery(book, 'tag:fantasy tag:scifi')).toBe(false)
  })
  it('tag + text combine', () => {
    expect(matchesQuery(book, 'tag:fantasy tolkien')).toBe(true)
    expect(matchesQuery(book, 'tag:fantasy dickens')).toBe(false)
  })
})
