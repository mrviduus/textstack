import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { UserBook } from '../../../api/userBooks'

vi.mock('../BookActionMenu', () => ({ BookActionMenu: () => null }))

import { UploadBookListItem } from '../UploadBookListItem'

afterEach(() => cleanup())

const book = (over: Partial<UserBook>) => ({
  id: 'pdf-1', title: 'My PDF', status: 'Processing', chapterCount: 0, coverPath: null,
  completedAt: null, progressPercent: 0.42, progressUpdatedAt: null, progressChapterSlug: null,
  ...over,
}) as UserBook

const renderRow = (b: UserBook) => render(
  <MemoryRouter>
    <UploadBookListItem book={b} language="en" highlighted={false} onChange={() => {}} t={k => k} />
  </MemoryRouter>,
)

// ADR-012: readability is derived — same rule as the grid card.
describe('UploadBookListItem', () => {
  it.each(['Processing', 'Failed'] as const)('a %s PDF with its original is a live link', status => {
    renderRow(book({ status, hasOriginalPdf: true }))
    expect(screen.getByText('My PDF').closest('a')?.getAttribute('href')).toBe('/en/library/my/pdf-1')
    expect(screen.getByText('library.continue').getAttribute('href')).toBe('/en/library/my/pdf-1/read')
  })

  it('a Processing EPUB is not clickable', () => {
    renderRow(book({ status: 'Processing', hasOriginalPdf: false }))
    expect(screen.getByText('My PDF').closest('a')).toBeNull()
  })
})
