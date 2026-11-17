import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k, language: 'en' }),
}))
vi.mock('../../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en' }),
}))

const markComplete = vi.fn(async (_id: string) => {})
const unmarkComplete = vi.fn(async (_id: string) => {})
const del = vi.fn(async (_id: string) => {})

vi.mock('../../../api/userBooks', () => ({
  markUserBookComplete: (id: string) => markComplete(id),
  unmarkUserBookComplete: (id: string) => unmarkComplete(id),
  deleteUserBook: (id: string) => del(id),
}))

import { BookActionMenu } from '../BookActionMenu'
import type { UserBook } from '../../../api/userBooks'

afterEach(() => { cleanup(); markComplete.mockClear(); unmarkComplete.mockClear(); del.mockClear() })

const wrap = (node: React.ReactElement) =>
  render(<MemoryRouter>{node}</MemoryRouter>)

const ub = (overrides: Partial<UserBook> = {}): UserBook => ({
  id: 'u1', title: 'Upload', slug: 'u', language: 'en', author: null, description: null,
  coverPath: null, genre: null, status: 'Ready', errorMessage: null, chapterCount: 1,
  totalWordCount: 100, createdAt: '', completedAt: null, progressPercent: 0,
  progressUpdatedAt: null, progressChapterSlug: null, ...overrides,
})

describe('BookActionMenu', () => {
  it('a Ready book offers view, mark finished and delete', () => {
    wrap(<BookActionMenu book={ub()} onChange={() => {}} />)
    fireEvent.click(screen.getByLabelText('library.actions.menu'))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'library.actions.viewDetails', 'library.actions.markFinished', 'library.actions.delete',
    ])
  })

  it('a Failed book offers delete only', () => {
    wrap(<BookActionMenu book={ub({ status: 'Failed' })} onChange={() => {}} />)
    fireEvent.click(screen.getByLabelText('library.actions.menu'))
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['library.actions.delete'])
  })

  it('finished book toggles label to "Mark unfinished"', () => {
    wrap(<BookActionMenu book={ub({ completedAt: '2026-01-01' })} onChange={() => {}} />)
    fireEvent.click(screen.getByLabelText('library.actions.menu'))
    expect(screen.getByText('library.actions.markUnfinished')).toBeInTheDocument()
  })
})
