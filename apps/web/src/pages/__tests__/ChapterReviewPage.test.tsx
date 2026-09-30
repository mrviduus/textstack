import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const getUserBook = vi.fn()
const getBookInsights = vi.fn()
const getUserBookHighlights = vi.fn()
vi.mock('../../api/userBooks', () => ({ getUserBook: (...a: unknown[]) => getUserBook(...a) }))
vi.mock('../../api/insights', () => ({ getBookInsights: (...a: unknown[]) => getBookInsights(...a) }))
vi.mock('../../api/userData', () => ({
  getUserBookHighlights: (...a: unknown[]) => getUserBookHighlights(...a),
  getPublicHighlights: vi.fn(),
}))
vi.mock('../../api/oauth', () => ({ listOAuthGrants: () => Promise.resolve([]) }))
const stableApi = {}
vi.mock('../../hooks/useApi', () => ({ useApi: () => stableApi }))
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, openAuthModal: vi.fn() }),
}))
vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))
vi.mock('../../components/SeoHead', () => ({ SeoHead: () => null }))

import { ChapterReviewPage } from '../ChapterReviewPage'

const book = {
  id: 'bk', title: 'AI Engineering', author: 'Chip Huyen',
  chapters: [
    { id: 'c1', chapterNumber: 2, slug: 'intro', title: 'Introduction' },
    { id: 'c2', chapterNumber: 3, slug: 'prompts', title: 'Prompt Engineering' },
    { id: 'c3', chapterNumber: 4, slug: 'rag', title: 'RAG and Agents' },
  ],
}

const block = (over = {}) => ({
  title: 'The model sees one blob', problem: 'Chat templates differ.', rootCause: 'Tokens are flat.',
  rule: 'Always render the template.', highlightIds: ['h-live', 'h-gone'],
  question: { prompt: 'Why does the template matter?', answer: 'Because the model sees one string.' },
  ...over,
})

const review = (over = {}) => ({
  methodVersion: 1, recall: null, blocks: [block()], applications: ['Your RAG service'],
  openThreads: [{ id: 't_1', text: 'How do agents plan?' }], closedThreadIds: [], ...over,
})

const insight = (slug: string, r: unknown) => ({
  id: `i-${slug}`, editionId: null, userBookId: 'bk', chapterSlug: slug, chapterNumber: 3, chapterTitle: null,
  text: 'md', question: 'Chapter review', source: 'mcp',
  createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T10:00:00Z', review: r,
})

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/en/library/my/bk/review/${slug}`]}>
      <Routes><Route path="/:lang/library/my/:id/review/:chapterSlug" element={<ChapterReviewPage />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  getUserBook.mockResolvedValue(book)
  getUserBookHighlights.mockResolvedValue([{ id: 'h-live', selectedText: 'one flat sequence of tokens' }])
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('ChapterReviewPage', () => {
  it('renders a block: problem, why, rule, highlights (incl. removed) and a hidden answer', async () => {
    getBookInsights.mockResolvedValue([insight('prompts', review())])
    renderAt('prompts')
    expect(await screen.findByText('1. The model sees one blob')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Prompt Engineering' })).toBeInTheDocument()
    expect(screen.getByText('Chat templates differ.')).toBeInTheDocument()
    expect(screen.getByText('Tokens are flat.')).toBeInTheDocument()
    expect(screen.getByText(/Always render the template\./)).toBeInTheDocument()
    expect(await screen.findByText('one flat sequence of tokens')).toBeInTheDocument()
    expect(screen.getByText('highlight removed')).toBeInTheDocument()
    expect(screen.getByText('reviewed 2026-09-30')).toBeInTheDocument()
    expect(screen.getByText('Your RAG service')).toBeInTheDocument()
    expect(screen.getByText('Open threads (1)')).toBeInTheDocument()
    // Never the chapter number.
    expect(screen.queryByText(/Chapter 3/)).toBeNull()

    expect(screen.queryByText('Because the model sees one string.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByText('Because the model sees one string.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByText('Because the model sees one string.')).toBeNull()
  })

  it('never flashes the "not reviewed yet" state while the insights are still loading', async () => {
    // The old hook set `loading` in its effect, so on the render where the book first arrived it was
    // still false with no insights: the page showed the empty state (and its h1) for a reviewed
    // chapter. That frame is what made the first test flaky — its h1 query resolved on it and the
    // block query that followed ran before the insights did.
    // Checked from INSIDE the fetch call: it runs in the effect right after the commit in question,
    // before any follow-up state update can paint over it.
    let sawEmptyState: boolean | null = null
    getBookInsights.mockImplementation(() => {
      sawEmptyState = !!screen.queryByText("This chapter hasn't been reviewed yet")
      return Promise.resolve([insight('prompts', review())])
    })
    renderAt('prompts')
    await waitFor(() => expect(getBookInsights).toHaveBeenCalled())
    expect(sawEmptyState).toBe(false)
    expect(await screen.findByText('1. The model sees one blob')).toBeInTheDocument()
  })

  it('recall-only review: shows what was remembered and "none" for blocks without highlights', async () => {
    getBookInsights.mockResolvedValue([insight('prompts', review({
      recall: 'Templates, few-shot, and that longer prompts cost more.',
      blocks: [block({ highlightIds: [] })],
    }))])
    renderAt('prompts')
    expect(await screen.findByText('What you remembered')).toBeInTheDocument()
    expect(screen.getByText('Templates, few-shot, and that longer prompts cost more.')).toBeInTheDocument()
    expect(screen.getByText('none')).toBeInTheDocument()
  })

  it('shows the text of a thread this chapter closed, taken from the review that opened it', async () => {
    getBookInsights.mockResolvedValue([
      insight('intro', review({ openThreads: [{ id: 't_old', text: 'What is a foundation model?' }] })),
      insight('prompts', review({ closedThreadIds: ['t_old'] })),
    ])
    renderAt('prompts')
    expect(await screen.findByText('Closed in this chapter')).toBeInTheDocument()
    expect(screen.getByText('What is a foundation model?')).toBeInTheDocument()
  })

  it('unreviewed chapter → empty state with the Review button', async () => {
    getBookInsights.mockResolvedValue([])
    renderAt('intro')
    expect(await screen.findByText("This chapter hasn't been reviewed yet")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Review “Introduction”/ })).toBeInTheDocument()
  })

  it('next chapter: its summary when reviewed, otherwise a Review button for it', async () => {
    getBookInsights.mockResolvedValue([insight('prompts', review()), insight('rag', review())])
    renderAt('prompts')
    expect(await screen.findByRole('link', { name: 'Next: RAG and Agents →' }))
      .toHaveAttribute('href', '/en/library/my/bk/review/rag')
    cleanup()

    getBookInsights.mockResolvedValue([insight('prompts', review())])
    renderAt('prompts')
    expect(await screen.findByRole('button', { name: 'Next: RAG and Agents →' })).toBeInTheDocument()
  })

  it('last chapter has no next', async () => {
    getBookInsights.mockResolvedValue([insight('rag', review())])
    renderAt('rag')
    await screen.findByRole('heading', { level: 1, name: 'RAG and Agents' })
    expect(screen.queryByText(/^Next:/)).toBeNull()
  })

  it('unknown chapter → not found', async () => {
    getBookInsights.mockResolvedValue([])
    renderAt('nope')
    expect(await screen.findByText('Chapter not found.')).toBeInTheDocument()
  })
})
