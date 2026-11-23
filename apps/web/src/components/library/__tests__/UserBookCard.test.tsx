import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { UserBook } from '../../../api/userBooks'

vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('../../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en' }),
}))
vi.mock('../../../hooks/useReadingPace', () => ({
  useReadingPace: () => ({ wpm: 200, sessionCount: 0, isUserSpecific: false }),
}))
// BookActionMenu pulls in navigation + API-backed hooks — out of scope here.
vi.mock('../BookActionMenu', () => ({ BookActionMenu: () => null }))

import { UserBookCard } from '../UserBookCard'

afterEach(() => cleanup())

function makeBook(over: Partial<UserBook>): UserBook {
  return {
    id: 'pdf-1',
    title: 'My PDF',
    slug: 'my-pdf',
    language: 'en',
    author: null,
    description: null,
    coverPath: null,
    genre: null,
    status: 'Ready',
    errorMessage: null,
    chapterCount: 0,
    totalWordCount: null,
    createdAt: '2020-01-01T00:00:00Z', // old → no "new" badge
    completedAt: null,
    progressPercent: 0.42,
    progressUpdatedAt: '2026-07-10T00:00:00Z',
    progressChapterSlug: null,
    ...over,
  }
}

function renderCard(book: UserBook) {
  return render(
    <MemoryRouter>
      <UserBookCard
        book={book}
        onDelete={() => {}}
        progress={{
          percent: book.progressPercent,
          chapterSlug: book.progressChapterSlug,
          updatedAt: book.progressUpdatedAt,
        }}
      />
    </MemoryRouter>,
  )
}

describe('UserBookCard PDF progress', () => {
  it('shows page-% for a PDF with its file', () => {
    const { container } = renderCard(makeBook({ hasOriginalPdf: true }))
    expect(screen.getByText('42% read')).toBeInTheDocument()
    const fill = container.querySelector('.user-book-card__progress-fill') as HTMLElement
    expect(fill).toBeTruthy()
    expect(fill.style.width).toBe('42%')
  })

  it('opens the book page from the title, and Continue goes to the chapterless Original reader', () => {
    // The card is the way into the BOOK (cover, chapters, notes); Continue is the way into the text.
    renderCard(makeBook({ hasOriginalPdf: true }))
    const title = screen.getByText('My PDF').closest('a') as HTMLAnchorElement
    expect(title.getAttribute('href')).toBe('/en/library/my/pdf-1')
    const cont = screen.getByText('library.continue').closest('a') as HTMLAnchorElement
    expect(cont.getAttribute('href')).toBe('/en/library/my/pdf-1/read')
  })

  it('a book whose file bytes are gone shows no progress and opens nothing', () => {
    renderCard(makeBook({ status: 'Failed' }))
    expect(screen.queryByText('42% read')).toBeNull()
  })
})

describe('UserBookCard destinations', () => {
  it('Continue resumes the chapter in progress; the title still opens the book page', () => {
    renderCard(makeBook({ id: 'b1', status: 'Ready', chapterCount: 10, progressChapterSlug: 'ch-5' }))
    expect((screen.getByText('My PDF').closest('a') as HTMLAnchorElement).getAttribute('href')).toBe('/en/library/my/b1')
    expect((screen.getByText('library.continue').closest('a') as HTMLAnchorElement).getAttribute('href')).toBe('/en/library/my/b1/read/ch-5')
  })

  it('shows no Continue before the reader has started — Start Reading lives on the book page', () => {
    renderCard(makeBook({ status: 'Ready', chapterCount: 10, progressPercent: 0 }))
    expect(screen.queryByText('library.continue')).toBeNull()
  })

  it('shows no Continue on a finished book', () => {
    renderCard(makeBook({ status: 'Ready', chapterCount: 10, completedAt: '2026-09-01T00:00:00Z', progressChapterSlug: 'ch-9' }))
    expect(screen.queryByText('library.continue')).toBeNull()
  })
})
