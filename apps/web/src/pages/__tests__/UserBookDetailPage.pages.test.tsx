import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// --- Mocks -----------------------------------------------------------------
const getUserBook = vi.fn()

vi.mock('../../api/userBooks', () => ({
  getUserBookProgress: () => Promise.resolve(null),
  getUserBook: (...a: unknown[]) => getUserBook(...a),
  deleteUserBook: vi.fn(),
  markUserBookComplete: vi.fn(),
  unmarkUserBookComplete: vi.fn(),
  getUserBookCoverUrl: (p: string) => p,
  getUserBookFileUrl: (id: string) => `/api/me/books/${id}/file`,
}))

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}))
vi.mock('../../components/library/BookInsightsSection', () => ({ BookInsightsSection: () => <div data-testid="insights" /> }))
const useBookReviews = vi.fn((_target: unknown) => ({ reviews: [], insights: [] }))
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

describe('UserBookDetailPage', () => {
  it('a book with its file shows its insights', async () => {
    getUserBook.mockResolvedValue({ ...baseBook, status: 'Ready', hasFile: true })
    renderPage()
    await screen.findByText('Test Book')
    expect(screen.getByTestId('insights')).toBeInTheDocument()
    expect(useBookReviews).toHaveBeenLastCalledWith({ userBookId: 'bk-1' })
  })

  it('a Ready book with no chapter offers no "Mark as read" (nothing to write completion on)', async () => {
    getUserBook.mockResolvedValue({ ...baseBook, status: 'Ready', chapters: [] })
    renderPage()
    await screen.findByText('Test Book')
    expect(screen.queryByText('Mark as read')).toBeNull()
  })

  // Review #1361: the reader reads the raw file, so the extraction's state does not gate it; the file's bytes do.
  it.each([['Processing', true, 1], ['Failed', true, 1], ['Ready', false, 0], ['Failed', false, 0]] as const)('a %s book, file in %s, offers Start Reading %i times', async (status, hasFile, shown) => {
    getUserBook.mockResolvedValue({ ...baseBook, status, chapters: [], hasFile })
    renderPage()
    await screen.findByText('Test Book')
    const links = screen.queryAllByRole('link', { name: 'Start Reading' })
    expect(links).toHaveLength(shown)
    if (shown) expect(links[0]).toHaveAttribute('href', '/en/library/my/bk-1/read')
  })

  // The server's chapter split is not the book's contents; one Contents link opens the reader's own.
  it('one Contents link into the reader, no server chapter list', async () => {
    getUserBook.mockResolvedValue({ ...baseBook, status: 'Ready', hasFile: true, chapters: [{ id: 'c1', chapterNumber: 1, slug: '', title: 'The Pond', wordCount: null }] })
    renderPage()
    await screen.findAllByRole('link', { name: /Reading/ })
    expect(screen.queryByRole('link', { name: /The Pond/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'Contents' }).getAttribute('href')).toMatch(/\/read\?contents=1$/)
  })
})
