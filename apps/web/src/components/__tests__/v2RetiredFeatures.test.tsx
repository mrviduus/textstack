import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, renderHook, screen, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { startV2Probe, resetV2ForTests } from '../../api/v2'
import { getGoals, getAchievements, getBookStats, getStats, getDailyStats, getReadingPace, getLibrarySummary } from '../../api/readingTracking'
import { getPendingWords, getLookups, getVocabSettings, getConcepts, getVocabStats, getVocabDailyStats, markAsKnown } from '../../api/vocabulary'
import { getHighlightsForReview } from '../../api/userData'
import { getDueReviewQuestions } from '../../api/reviewQuestions'
import { fakeApi } from '../../../../../packages/shared/src/api/__tests__/fakeV2Api'

let v2On = false
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
  useV2: () => ({ enabled: v2On, maxPartBytes: 0 }),
}))
vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))
vi.mock('../../api/userData', async (original) => ({
  ...(await original<typeof import('../../api/userData')>()),
  getAllHighlights: () => Promise.resolve({ items: [], totalCount: 1 }),
}))
vi.mock('../SeoHead', () => ({ SeoHead: () => null }))
vi.mock('../Footer', () => ({ Footer: () => null }))

import { OffV2 } from '../OffV2'
import { HighlightsPage } from '../../pages/HighlightsPage'
import { useQuickStats } from '../../hooks/useQuickStats'

// M5 (#1031): features with no V2 storage (owner, 2026-11-16). On V2 their legacy routes answer 410.
const READS: [() => Promise<unknown>, string][] = [
  [() => getGoals(), 'GET /me/reading/goals'],
  [() => getAchievements(), 'GET /me/reading/achievements'],
  [() => getBookStats(), 'GET /me/reading/book-stats'],
  [() => getStats(), 'GET /me/reading/stats'],
  [() => getDailyStats(), 'GET /me/reading/stats/daily'],
  [() => getReadingPace(), 'GET /me/reading/pace'],
  [() => getLibrarySummary(), 'GET /me/reading/library-summary'],
  [() => getPendingWords(), 'GET /me/vocabulary/pending'],
  [() => getLookups(), 'GET /me/vocabulary/lookups'],
  [() => getVocabSettings(), 'GET /me/vocabulary/settings'],
  [() => getConcepts(), 'GET /me/vocabulary/concepts'],
  [() => getVocabStats(), 'GET /me/vocabulary/stats'],
  [() => getVocabDailyStats(), 'GET /me/vocabulary/stats/daily'],
  [() => markAsKnown('w1'), 'PUT /me/vocabulary/words/w1/known'],
  [() => getHighlightsForReview(), 'GET /me/highlights/review'],
  [() => getDueReviewQuestions(), 'GET /me/review-questions/due'],
]

/** A hidden page and the parent it falls back to. */
const PAGES: [string, string, string][] = [
  ['/en/stats', 'stats page', 'home'],
  ['/en/highlights/review', 'highlight review', 'highlights'],
  ['/en/review/questions', 'chapter questions', 'vocabulary'],
  ['/en/library/my/b1/review/ch-1', 'chapter review', 'book'],
  ['/en/library/shelf/recent', 'shelf', 'library'],
]

function app(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/:lang" element={<p>home</p>} />
        <Route path="/:lang/highlights" element={<p>highlights</p>} />
        <Route path="/:lang/vocabulary" element={<p>vocabulary</p>} />
        <Route path="/:lang/library" element={<p>library</p>} />
        <Route path="/:lang/library/my/:id" element={<p>book</p>} />
        <Route path="/:lang/stats" element={<OffV2 feature="readingStats" to=".."><p>stats page</p></OffV2>} />
        <Route path="/:lang/highlights/review" element={<OffV2 feature="highlightReview" to=".."><p>highlight review</p></OffV2>} />
        <Route path="/:lang/review/questions" element={<OffV2 feature="chapterReview" to="../../vocabulary"><p>chapter questions</p></OffV2>} />
        <Route path="/:lang/library/my/:id/review/:slug" element={<OffV2 feature="chapterReview" to="../.."><p>chapter review</p></OffV2>} />
        <Route path="/:lang/library/shelf/:shelfId" element={<OffV2 feature="shelves" to="../.."><p>shelf</p></OffV2>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function start(on: boolean) {
  v2On = on
  fakeApi({ 'GET /me/v2/status': [on ? { status: 200, body: { maxPartBytes: 1024 } } : { status: 404 }] })
  await startV2Probe()
}

const reviewButton = () => document.querySelector('.vocab-review-btn')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetV2ForTests()
  localStorage.clear()
})

describe('the features V2 holds no data for', () => {
  it('with V2 on, a reader never sees or calls them', async () => {
    await start(true)
    const calls = fakeApi({})
    for (const [read] of READS) await expect(read()).rejects.toMatchObject({ status: 410 })
    expect(calls).toEqual([])

    for (const [path, page, parent] of PAGES) {
      app(path)
      expect(screen.getByText(parent)).toBeTruthy()
      expect(screen.queryByText(page)).toBeNull()
      cleanup()
    }

    render(<MemoryRouter><HighlightsPage /></MemoryRouter>)
    await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull())
    expect(reviewButton()).toBeNull()
    expect(renderHook(() => useQuickStats()).result.current).toBeNull()
    expect(calls).toEqual([])
  })

  it('with V2 off, everything is as before', async () => {
    await start(false)
    for (const [read, route] of READS) {
      const calls = fakeApi({ [route]: [{ status: 200, body: [] }] })
      await read().catch(() => null)
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([route])
    }

    for (const [path, page] of PAGES) {
      app(path)
      expect(screen.getByText(page)).toBeTruthy()
      cleanup()
    }

    render(<MemoryRouter><HighlightsPage /></MemoryRouter>)
    await waitFor(() => expect(reviewButton()).not.toBeNull())
  })
})
