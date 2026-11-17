import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const getUserBook = vi.fn()
const getBookInsights = vi.fn()
const getUserBookProgress = vi.fn(() => Promise.resolve(null as unknown))
vi.mock('../../api/userBooks', () => ({
  getUserBook: (...a: unknown[]) => getUserBook(...a),
  getUserBookProgress: () => getUserBookProgress(),
  deleteUserBook: vi.fn(),
  markUserBookComplete: vi.fn(), unmarkUserBookComplete: vi.fn(),
  getUserBookCoverUrl: (p: string) => p,
  getUserBookFileUrl: (id: string) => `/api/me/books/${id}/file`,
}))
vi.mock('@textstack/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@textstack/shared')>()),
  insightsApi: { getBookInsights: (...a: unknown[]) => getBookInsights(...a) },
}))
vi.mock('../../api/oauth', () => ({ listOAuthGrants: () => Promise.resolve([]) }))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }))
vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))
vi.mock('../../components/SeoHead', () => ({ SeoHead: () => null }))
vi.mock('../../components/Footer', () => ({ Footer: () => null }))

import { UserBookDetailPage } from '../UserBookDetailPage'

const book = {
  id: 'bk', title: 'AI Engineering', author: 'Chip Huyen', description: null, language: 'en', genre: null,
  publishedYear: null, totalWordCount: null, status: 'Ready', hasOriginalPdf: false, errorMessage: null,
  coverPath: null, completedAt: null, hasFile: true,
  chapters: [
    { id: 'c1', chapterNumber: 1, slug: 'intro', title: 'Introduction', wordCount: null },
    { id: 'c2', chapterNumber: 2, slug: 'prompts', title: 'Prompt Engineering', wordCount: null },
  ],
}

describe('UserBookDetailPage progress', () => {
  it('server progress wins over this browser: Continue Reading + current chapter in the Assistant menu', async () => {
    localStorage.clear()
    getUserBookProgress.mockResolvedValueOnce({ chapterSlug: 'prompts', locator: null, percent: 0.44, updatedAt: null })
    getUserBook.mockResolvedValue(book)
    getBookInsights.mockResolvedValue([])
    render(
      <MemoryRouter initialEntries={['/en/library/my/bk']}>
        <Routes><Route path="/:lang/library/my/:id" element={<UserBookDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    const cont = await screen.findByText('Continue Reading')
    expect(cont.closest('a')).toHaveAttribute('href', '/en/library/my/bk/read/prompts')
  })
})
