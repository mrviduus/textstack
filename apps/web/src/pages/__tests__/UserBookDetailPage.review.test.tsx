import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const getUserBook = vi.fn()
const getBookInsights = vi.fn()
const getUserBookProgress = vi.fn(() => Promise.resolve(null as unknown))
vi.mock('../../api/userBooks', () => ({
  getUserBook: (...a: unknown[]) => getUserBook(...a),
  getUserBookProgress: () => getUserBookProgress(),
  enrichUserBook: vi.fn(), deleteUserBook: vi.fn(), retryUserBook: vi.fn(),
  markUserBookComplete: vi.fn(), unmarkUserBookComplete: vi.fn(),
  getUserBookCoverUrl: (p: string) => p,
}))
vi.mock('../../api/insights', () => ({
  getBookInsights: (...a: unknown[]) => getBookInsights(...a),
  deleteBookInsight: vi.fn(),
}))
vi.mock('../../api/oauth', () => ({ listOAuthGrants: () => Promise.resolve([]) }))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }))
vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))
vi.mock('../../components/SeoHead', () => ({ SeoHead: () => null }))
vi.mock('../../components/Footer', () => ({ Footer: () => null }))
vi.mock('../../components/library/BookStatsSection', () => ({ BookStatsSection: () => null }))

import { UserBookDetailPage } from '../UserBookDetailPage'

const review = { methodVersion: 1, recall: null, blocks: [], applications: [], openThreads: [], closedThreadIds: [] }

describe('UserBookDetailPage chapter list — review actions', () => {
  it('reviewed chapter links to its summary; the others get a Review button', async () => {
    getUserBook.mockResolvedValue({
      id: 'bk', title: 'AI Engineering', author: 'Chip Huyen', description: null, language: 'en', genre: null,
      publishedYear: null, totalWordCount: null, status: 'Ready', hasOriginalPdf: false, errorMessage: null,
      coverPath: null, completedAt: null, metadataEnrichmentStatus: 'Succeeded',
      chapters: [
        { id: 'c1', chapterNumber: 1, slug: 'intro', title: 'Introduction', wordCount: null },
        { id: 'c2', chapterNumber: 2, slug: 'prompts', title: 'Prompt Engineering', wordCount: null },
      ],
    })
    getBookInsights.mockResolvedValue([{
      id: 'i', editionId: null, userBookId: 'bk', chapterSlug: 'intro', chapterNumber: 1, chapterTitle: 'Introduction',
      text: 'md', question: null, source: 'mcp', createdAt: '2026-09-30', updatedAt: '2026-09-30', review,
    }])

    render(
      <MemoryRouter initialEntries={['/en/library/my/bk']}>
        <Routes><Route path="/:lang/library/my/:id" element={<UserBookDetailPage />} /></Routes>
      </MemoryRouter>,
    )

    const reviewed = await screen.findByRole('link', { name: 'Open the review of “Introduction”' })
    expect(reviewed).toHaveAttribute('href', '/en/library/my/bk/review/intro')
    expect(reviewed).toHaveTextContent('✓ Reviewed →')

    const list = document.querySelector('.user-book-detail__chapter-list') as HTMLElement
    expect(within(list).getByRole('button', { name: 'Discuss “Prompt Engineering” with your assistant' })).toBeInTheDocument()
    expect(within(list).queryByRole('button', { name: /Introduction/ })).toBeNull()
  })

  it('server progress wins over this browser: Continue Reading + current chapter in the Assistant menu', async () => {
    localStorage.clear()
    getUserBookProgress.mockResolvedValueOnce({ chapterSlug: 'prompts', locator: null, percent: 0.44, updatedAt: null })
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
