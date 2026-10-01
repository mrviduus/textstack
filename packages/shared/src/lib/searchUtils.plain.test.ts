import { describe, it, expect } from 'vitest'
import { normalizeForSearch, matchesQuery } from './searchUtils'

describe('normalizeForSearch', () => {
  it('returns empty string for null', () => {
    expect(normalizeForSearch(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(normalizeForSearch(undefined)).toBe('')
  })

  it('returns empty string for empty string', () => {
    expect(normalizeForSearch('')).toBe('')
  })

  it('lowercases ASCII', () => {
    expect(normalizeForSearch('Dracula')).toBe('dracula')
  })

  it('strips Latin diacritics (NFD decomposition)', () => {
    expect(normalizeForSearch('Pâtisserie')).toBe('patisserie')
    expect(normalizeForSearch('NAÏVE')).toBe('naive')
    expect(normalizeForSearch('Łódź')).toBe('łodz') // ł survives (not combining), but ó → o
  })

  it('strips combining marks even from Cyrillic (й = и + combining breve)', () => {
    // Real behavior documented: "й" decomposes to "и" + U+0306 (combining
    // breve). The diacritic strip turns "й" → "и". This is intentional —
    // it means a user typing "достоевскии" matches "Достоевский" entries,
    // which is friendlier for typos than strict NFC matching.
    expect(normalizeForSearch('Достоевский')).toBe('достоевскии')
    // Letters without combining marks pass through unchanged.
    expect(normalizeForSearch('Толстой')).toBe('толстои') // "й" stripped similarly
    expect(normalizeForSearch('Чехов')).toBe('чехов')
  })

  it('handles mixed case + diacritics + whitespace', () => {
    expect(normalizeForSearch('  Lévi-Strauss  ')).toBe('  levi-strauss  ')
  })
})

describe('matchesQuery', () => {
  it('empty query matches anything (no filter)', () => {
    expect(matchesQuery({ title: 'War and Peace', author: 'Tolstoy' }, '')).toBe(true)
  })

  it('whitespace-only query matches anything', () => {
    expect(matchesQuery({ title: 'War and Peace', author: 'Tolstoy' }, '   ')).toBe(true)
  })

  it('matches by title (case-insensitive)', () => {
    expect(matchesQuery({ title: 'Dracula', author: 'Stoker' }, 'dracula')).toBe(true)
    expect(matchesQuery({ title: 'Dracula', author: 'Stoker' }, 'DRACULA')).toBe(true)
  })

  it('matches by author', () => {
    expect(matchesQuery({ title: 'Dracula', author: 'Bram Stoker' }, 'stoker')).toBe(true)
  })

  it('matches across title + author (multi-term AND)', () => {
    expect(matchesQuery({ title: 'Dracula', author: 'Bram Stoker' }, 'dracula stoker')).toBe(true)
  })

  it('does not match when any term missing', () => {
    expect(matchesQuery({ title: 'Dracula', author: 'Stoker' }, 'dracula tolstoy')).toBe(false)
  })

  it('matches partial substrings', () => {
    expect(matchesQuery({ title: 'War and Peace', author: 'Tolstoy' }, 'pea')).toBe(true)
  })

  it('matches with diacritics stripped on both sides', () => {
    expect(matchesQuery({ title: 'Pâtisserie', author: null }, 'patiss')).toBe(true)
  })

  it('returns false for null fields without query match', () => {
    expect(matchesQuery({ title: null, author: null }, 'anything')).toBe(false)
  })

  it('handles undefined fields gracefully', () => {
    expect(matchesQuery({}, 'foo')).toBe(false)
    expect(matchesQuery({}, '')).toBe(true) // empty query = match
  })

  it('extra whitespace in query splits cleanly', () => {
    expect(matchesQuery({ title: 'A B C', author: null }, '  a   b  ')).toBe(true)
  })
})
