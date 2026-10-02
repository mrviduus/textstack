import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// --- Mocks -----------------------------------------------------------------
const getUserBook = vi.fn()
const enrichUserBook = vi.fn()

vi.mock('../../api/userBooks', () => ({
  getUserBookProgress: () => Promise.resolve(null),
  getUserBook: (...a: unknown[]) => getUserBook(...a),
  enrichUserBook: (...a: unknown[]) => enrichUserBook(...a),
  deleteUserBook: vi.fn(),
  retryUserBook: vi.fn(),
  markUserBookComplete: vi.fn(),
  unmarkUserBookComplete: vi.fn(),
  getUserBookCoverUrl: (p: string) => p,
  getUserBookFileUrl: (id: string) => `/api/me/books/${id}/file`,
}))

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}))
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

describe('UserBookDetailPage enrich retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retry error keeps page rendered (no page-level error) and shows inline enrich error', async () => {
    getUserBook.mockResolvedValue({ ...baseBook })
    enrichUserBook.mockRejectedValue(new Error('sweep already re-claimed'))

    renderPage()

    // Failed badge + Retry rendered after initial load.
    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(getUserBook).toHaveBeenCalledTimes(1)

    fireEvent.click(retry)

    // Inline, local error surfaces...
    await waitFor(() =>
      expect(screen.getByText('sweep already re-claimed')).toBeInTheDocument(),
    )
    // ...the page stayed mounted (title present, NOT the full-page error screen).
    expect(screen.getByText('Test Book')).toBeInTheDocument()
    expect(screen.queryByText('Book not found')).not.toBeInTheDocument()
    // ...and we reconciled true status via a refetch (2nd getUserBook call).
    expect(getUserBook).toHaveBeenCalledTimes(2)
  })
})
