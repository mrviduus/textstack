import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { syncApi } from '@textstack/shared'
import '../../api/client' // initApi, as the app does on load
import { HighlightsPage } from '../HighlightsPage'
import { emitDataChange } from '../../lib/dataEvents'
import { COVER_RETRY_MS } from '../../hooks/useCoverRetry'
import type { HighlightListItem } from '@textstack/shared'

const item = (over: Partial<HighlightListItem>) => ({
  id: 'h1', selectedText: 'quote', anchorJson: '{}', color: 'yellow', noteText: null, createdAt: '2026-11-24T00:00:00Z',
  editionId: null, editionTitle: null, editionSlug: null, editionCoverPath: null,
  userBookId: 'b1', userBookTitle: 'A Book', userBookCoverPath: null,
  chapterId: null, userChapterId: null, chapterTitle: null, userChapterTitle: null, chapterSlug: null, userChapterSlug: null,
  deletedBookTitle: null, userBookCoverVersion: null, ...over,
}) as HighlightListItem

const items = vi.hoisted(() => ({ list: [] as HighlightListItem[], fail: false }))
vi.mock('@textstack/shared', async (importOriginal) => {
  const shared = await importOriginal<typeof import('@textstack/shared')>()
  return { ...shared, highlightsApi: { ...shared.highlightsApi, getAllHighlights: async () => {
    if (items.fail) throw new Error('502')
    return { items: items.list, totalCount: items.list.length }
  } } }
})
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

  // #1584: a network blip, not a broken cover: back online, the same URL is tried again without a reload.
  it('cover that failed while offline renders again when the browser is back online', async () => {
    const container = await renderCovers([item({ userBookCoverVersion: '2026-11-24T09:30:15Z' })])
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()

    act(() => { window.dispatchEvent(new Event('offline')) })
    act(() => { window.dispatchEvent(new Event('online')) })

    expect(container.querySelector('img')?.getAttribute('src')).toBe(syncApi.coverUrl('b1', '2026-11-24T09:30:15Z'))
  })

  // #1591: a 502 or a timeout while the network stays up: the cover is tried once more after a delay.
  it('cover that failed while online is tried again once after a delay', async () => {
    const container = await renderCovers([item({ userBookCoverVersion: '2026-11-24T09:30:15Z' })])
    vi.useFakeTimers()
    try {
      fireEvent.error(container.querySelector('img')!)
      expect(container.querySelector('img')).toBeNull()
      act(() => { vi.advanceTimersByTime(COVER_RETRY_MS) })
      expect(container.querySelector('img')).not.toBeNull()

      fireEvent.error(container.querySelector('img')!)
      act(() => { vi.advanceTimersByTime(COVER_RETRY_MS * 2) })
      expect(container.querySelector('img')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('failed cover with a new version for the same book renders again', async () => {
    const container = await renderCovers([item({ userBookCoverVersion: '2026-11-24T09:30:15Z' })])
    fireEvent.error(container.querySelector('img')!)

    items.list = [item({ userBookCoverVersion: '2026-11-25T10:00:00Z' })]
    act(() => emitDataChange('highlights'))

    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(syncApi.coverUrl('b1', '2026-11-25T10:00:00Z')))
  })

  it('a book cover follows its last fetched highlight: a newer cover, or none once removed', async () => {
    // Pages arrive in order; a later one carries the server's newest state of the book.
    const newer = await renderCovers([
      item({ id: 'h1', userBookCoverVersion: '2026-11-24T09:30:15Z' }),
      item({ id: 'h2', userBookCoverVersion: '2026-11-25T10:00:00.5+00:00' }),
    ])
    expect(newer.querySelectorAll('img')).toHaveLength(1)
    expect(newer.querySelector('img')?.getAttribute('src')).toBe(syncApi.coverUrl('b1', '2026-11-25T10:00:00.5+00:00'))

    const removed = await renderCovers([
      item({ id: 'h3', userBookCoverVersion: '2026-11-24T09:30:15Z' }),
      item({ id: 'h4', userBookCoverVersion: null }),
    ])
    expect(removed.querySelector('img')).toBeNull()
  })
})

// #1591: a failed list is not "no highlights": the page says so and loads again back online.
describe('HighlightsPage load failure', () => {
  it('failed load shows an error, then the list once the browser is back online', async () => {
    items.list = [item({})]
    items.fail = true
    const { container } = render(<MemoryRouter><HighlightsPage embedded /></MemoryRouter>)
    await waitFor(() => expect(container.textContent).toContain('Could not load your highlights'))
    expect(container.textContent).not.toContain('Your highlights will appear here')

    items.fail = false
    act(() => { window.dispatchEvent(new Event('offline')) })
    act(() => { window.dispatchEvent(new Event('online')) })

    await waitFor(() => expect(container.textContent).toContain('quote'))
  })
})
