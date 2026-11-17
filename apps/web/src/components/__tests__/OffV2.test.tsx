import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

let v2On = false
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
  useV2: () => ({ enabled: v2On, maxPartBytes: 0 }),
}))
vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))
vi.mock('../../api/userData', () => ({
  getAllHighlights: () => Promise.resolve({ items: [], totalCount: 1 }),
}))
vi.mock('../SeoHead', () => ({ SeoHead: () => null }))
vi.mock('../Footer', () => ({ Footer: () => null }))

import { OffV2 } from '../OffV2'
import { HighlightsPage } from '../../pages/HighlightsPage'

// M5 (#1031): a page V2 holds no data for redirects to its parent with V2 on; V2 off it renders as before.
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:lang" element={<p>home</p>} />
        <Route path="/:lang/vocabulary" element={<p>vocabulary</p>} />
        <Route path="/:lang/library/my/:id" element={<p>book</p>} />
        <Route path="/:lang/stats" element={<OffV2 feature="readingStats" to=".."><p>stats</p></OffV2>} />
        <Route path="/:lang/review/questions" element={<OffV2 feature="chapterReview" to="../../vocabulary"><p>questions</p></OffV2>} />
        <Route path="/:lang/library/my/:id/review/:slug" element={<OffV2 feature="chapterReview" to="../.."><p>review</p></OffV2>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('OffV2', () => {
  it.each([
    ['/en/stats', 'stats', 'home'],
    ['/en/review/questions', 'questions', 'vocabulary'],
    ['/en/library/my/b1/review/ch-1', 'review', 'book'],
  ])('%s: the page with V2 off, its parent with V2 on', (path, page, parent) => {
    v2On = false
    const { unmount } = renderAt(path)
    expect(screen.getByText(page)).toBeTruthy()
    unmount()
    v2On = true
    renderAt(path)
    expect(screen.getByText(parent)).toBeTruthy()
    expect(screen.queryByText(page)).toBeNull()
  })
})

describe('HighlightsPage review entry', () => {
  it.each([[false, true], [true, false]])('V2 on = %s: Review button shown = %s', async (on, shown) => {
    v2On = on
    render(<MemoryRouter><HighlightsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull())
    expect(document.querySelector('.vocab-review-btn') !== null).toBe(shown)
  })
})
