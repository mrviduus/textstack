import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { UserBook } from '../../../api/userBooks'

vi.mock('../BookActionMenu', () => ({ BookActionMenu: () => null }))

import { UploadBookListItem } from '../UploadBookListItem'

afterEach(() => cleanup())

const book = (over: Partial<UserBook>) => ({
  id: 'pdf-1', title: 'My PDF', status: 'Ready', chapterCount: 0, coverPath: null,
  completedAt: null, progressPercent: 0.42, progressUpdatedAt: null, progressChapterSlug: null,
  ...over,
}) as UserBook

const renderRow = (b: UserBook) => render(
  <MemoryRouter>
    <UploadBookListItem book={b} language="en" highlighted={false} onChange={() => {}} t={k => k} />
  </MemoryRouter>,
)

// ADR-033: a book is readable when its file's bytes are in, whatever the server extracted.
describe('UploadBookListItem', () => {
  it('a PDF with its file is a live link', () => {
    renderRow(book({ hasOriginalPdf: true }))
    expect(screen.getByText('My PDF').closest('a')?.getAttribute('href')).toBe('/en/library/my/pdf-1')
    expect(screen.getByText('library.continue').getAttribute('href')).toBe('/en/library/my/pdf-1/read')
  })

  it('a book whose file bytes are gone is not clickable', () => {
    renderRow(book({ status: 'Failed' }))
    expect(screen.getByText('My PDF').closest('a')).toBeNull()
  })
})
