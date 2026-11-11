import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// --- Mocks -----------------------------------------------------------------
const getUserBook = vi.fn()

vi.mock('../../api/userBooks', () => ({
  getUserBookProgress: () => Promise.resolve(null),
  getUserBook: (...a: unknown[]) => getUserBook(...a),
  enrichUserBook: vi.fn(),
  deleteUserBook: vi.fn(),
  retryUserBook: vi.fn(),
  markUserBookComplete: vi.fn(),
  unmarkUserBookComplete: vi.fn(),
  getUserBookCoverUrl: (p: string) => p,
  getUserBookFileUrl: (id: string) => `/api/me/books/${id}/file`,
}))

let v2On = false
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
  useV2: () => ({ enabled: v2On, maxPartBytes: 0 }),
}))
vi.mock('../../components/library/BookStatsSection', () => ({ BookStatsSection: () => <div data-testid="stats" /> }))
vi.mock('../../components/library/BookInsightsSection', () => ({ BookInsightsSection: () => <div data-testid="insights" /> }))
const useBookReviews = vi.fn((_target: unknown) => ({ reviews: [], insights: [], remove: vi.fn() }))
vi.mock('../../hooks/useBookReviews', () => ({ useBookReviews: (t: unknown) => useBookReviews(t), currentReviewChapter: () => null }))
vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en' }),
}))
// Keep useTranslation real (reads en.json) but stub the heavy view chrome.
vi.mock('../../components/SeoHead', () => ({ SeoHead: () => null }))
vi.mock('../../components/Footer', () => ({ Footer: () => null }))

import { UserBookDetailPage } from '../UserBookDetailPage'

const baseBook = {
  id: 'bk-1',
  title: 'Test Book',
  author: null,
  description: null,
  language: 'en',
  genre: null,
  publishedYear: null,
  totalWordCount: null,
  status: 'Processing' as const,
  hasOriginalPdf: false,
  errorMessage: null,
  coverPath: null,
  completedAt: null,
  chapters: [],
  metadataEnrichmentStatus: 'Failed' as const,
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/en/library/my/bk-1']}>
      <Routes>
        <Route path="/:lang/library/my/:id" element={<UserBookDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('UserBookDetailPage page count', () => {
  it.each([
    [{ pageCount: 1 }, '1 page'],
    [{ totalWordCount: 100 }, '~1 page'],
    [{ pageCount: 15, totalWordCount: 8250 }, '15 pages'],
    [{ totalWordCount: 8250 }, '~33 pages'],
  ])('PDF-2: %o shows "%s"', async (fields, label) => {
    getUserBook.mockResolvedValue({ ...baseBook, ...fields })
    renderPage()
    expect(await screen.findByText(label)).toBeInTheDocument()
  })
})

describe('UserBookDetailPage on V2', () => {
  it.each([[false, 1], [true, 0]])('V2 %s: stats, insights and re-extract shown %i times (V2_FEATURES)', async (on, shown) => {
    v2On = on
    getUserBook.mockResolvedValue({ ...baseBook, status: 'Ready', metadataEnrichmentStatus: undefined })
    renderPage()
    await screen.findByText('Test Book')
    expect(screen.queryAllByTestId('stats')).toHaveLength(shown)
    expect(screen.queryAllByTestId('insights')).toHaveLength(shown)
    expect(screen.queryAllByLabelText(/Re-extract this book/)).toHaveLength(shown)
    expect(useBookReviews).toHaveBeenLastCalledWith(on ? null : { userBookId: 'bk-1' })
    v2On = false
  })

  it.each([[false, 1], [true, 0]])('V2 %s: a Ready book with no chapter offers "Mark as read" %i times (nothing to write completion on)', async (on, shown) => {
    v2On = on
    getUserBook.mockResolvedValue({ ...baseBook, status: 'Ready', metadataEnrichmentStatus: undefined, chapters: [] })
    renderPage()
    await screen.findByText('Test Book')
    expect(screen.queryAllByText('Mark as read')).toHaveLength(shown)
    v2On = false
  })

  it.each([[false, 0], [true, 1]])('V2 %s: the V2 reader link shown %i times (#1225)', async (on, shown) => {
    v2On = on
    getUserBook.mockResolvedValue({ ...baseBook, status: 'Ready', metadataEnrichmentStatus: undefined })
    renderPage()
    await screen.findByText('Test Book')
    const links = screen.queryAllByRole('link', { name: 'Open in the V2 reader' })
    expect(links).toHaveLength(shown)
    if (on) expect(links[0]).toHaveAttribute('href', '/en/library/my/bk-1/read-v2')
    v2On = false
  })
})
