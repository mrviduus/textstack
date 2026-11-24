import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { syncApi } from '@textstack/shared'
import '../../api/client' // initApi, as the app does on load
import { HighlightsPage } from '../HighlightsPage'
import { emitDataChange } from '../../lib/dataEvents'
import type { HighlightListItem } from '../../api/userData'

const item = (over: Partial<HighlightListItem>) => ({
  id: 'h1', selectedText: 'quote', anchorJson: '{}', color: 'yellow', noteText: null, createdAt: '2026-11-24T00:00:00Z',
  editionId: null, editionTitle: null, editionSlug: null, editionCoverPath: null,
  userBookId: 'b1', userBookTitle: 'A Book', userBookCoverPath: null,
  chapterId: null, userChapterId: null, chapterTitle: null, userChapterTitle: null, chapterSlug: null, userChapterSlug: null,
  deletedBookTitle: null, userBookCoverVersion: null, ...over,
}) as HighlightListItem

const items = vi.hoisted(() => ({ list: [] as HighlightListItem[] }))
vi.mock('../../api/userData', () => ({
  getAllHighlights: async () => ({ items: items.list, totalCount: items.list.length }),
}))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }))
vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))

async function renderCovers(list: HighlightListItem[]) {
  items.list = list
  const { container } = render(<MemoryRouter><HighlightsPage embedded /></MemoryRouter>)
  await waitFor(() => expect(container.textContent).toContain('quote'))
  return container
}

// #1580: a highlight's cover is the library's URL (same cache key); a failed one hides instead of a broken icon.
describe('HighlightsPage cover', () => {
  it('book with a cover version shows the library cover URL', async () => {
    const container = await renderCovers([item({ userBookCoverVersion: '2026-11-24T09:30:15.123456Z' })])
    expect(container.querySelector('img')?.getAttribute('src')).toBe(syncApi.coverUrl('b1', '2026-11-24T09:30:15.123456Z'))
  })

  it('book without a cover version shows no image', async () => {
    const container = await renderCovers([item({ userBookCoverVersion: null })])
    expect(container.querySelector('img')).toBeNull()
  })

  it('cover that fails to load is hidden', async () => {
    const container = await renderCovers([item({ userBookCoverVersion: '2026-11-24T09:30:15Z' })])
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
  })

  it('failed cover with a new version for the same book renders again', async () => {
    const container = await renderCovers([item({ userBookCoverVersion: '2026-11-24T09:30:15Z' })])
    fireEvent.error(container.querySelector('img')!)

    items.list = [item({ userBookCoverVersion: '2026-11-25T10:00:00Z' })]
    act(() => emitDataChange('highlights'))

    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(syncApi.coverUrl('b1', '2026-11-25T10:00:00Z')))
  })

  it('book whose later highlight carries a newer version shows the newest cover', async () => {
    const container = await renderCovers([
      item({ id: 'h1', userBookCoverVersion: '2026-11-24T09:30:15Z' }),
      item({ id: 'h2', userBookCoverVersion: '2026-11-25T10:00:00.5+00:00' }),
      item({ id: 'h3', userBookCoverVersion: null }),
    ])
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(syncApi.coverUrl('b1', '2026-11-25T10:00:00.5+00:00'))
  })
})
