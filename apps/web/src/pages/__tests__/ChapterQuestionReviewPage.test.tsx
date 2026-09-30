import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const getDueReviewQuestions = vi.fn()
const answerReviewQuestion = vi.fn()
vi.mock('../../api/reviewQuestions', () => ({
  getDueReviewQuestions: (...a: unknown[]) => getDueReviewQuestions(...a),
  answerReviewQuestion: (...a: unknown[]) => answerReviewQuestion(...a),
}))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, isLoading: false }) }))
vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))
vi.mock('../../components/SeoHead', () => ({ SeoHead: () => null }))

import { ChapterQuestionReviewPage } from '../ChapterQuestionReviewPage'
import { ChapterQuestionsCard } from '../../components/vocabulary/ChapterQuestionsCard'

const q = (id: string, over = {}) => ({
  id, prompt: `Prompt ${id}?`, answer: `Answer ${id}`, blockTitle: 'Chat templates', rule: `Rule ${id}`,
  bookTitle: 'AI Engineering', chapterTitle: 'Prompt Engineering', chapterSlug: 'prompts',
  userBookId: 'bk', editionId: null, ...over,
})

const renderIn = (el: React.ReactNode) => render(<MemoryRouter>{el}</MemoryRouter>)

beforeEach(() => answerReviewQuestion.mockResolvedValue({ stage: 1, nextReviewAt: '2026-10-01T00:00:00Z', retired: false }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('ChapterQuestionReviewPage', () => {
  it('show → answer → POST → next → end screen', async () => {
    getDueReviewQuestions.mockResolvedValue({ totalDue: 2, items: [q('a'), q('b', { chapterTitle: null })] })
    renderIn(<ChapterQuestionReviewPage />)

    expect(await screen.findByText('Prompt a?')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    expect(screen.queryByText('Answer a')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Knew' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show answer' }))
    expect(screen.getByText('Answer a')).toBeInTheDocument()
    expect(screen.getByText('★ Rule a')).toBeInTheDocument()
    expect(screen.getByText('AI Engineering · Prompt Engineering')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Knew' }))
    expect(await screen.findByText('Prompt b?')).toBeInTheDocument()
    expect(answerReviewQuestion).toHaveBeenCalledWith('a', 'knew')
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(screen.queryByText('Answer b')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show answer' }))
    expect(screen.getByText('AI Engineering')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Forgot' }))
    expect(await screen.findByText('Done for now')).toBeInTheDocument()
    expect(answerReviewQuestion).toHaveBeenLastCalledWith('b', 'forgot')
    expect(screen.getByRole('link', { name: 'Back to Practice' })).toHaveAttribute('href', '/en/vocabulary')
  })

  it('a failed answer stays on the card and says so', async () => {
    getDueReviewQuestions.mockResolvedValue({ totalDue: 1, items: [q('a')] })
    answerReviewQuestion.mockRejectedValueOnce(new Error('500'))
    renderIn(<ChapterQuestionReviewPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show answer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Almost' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that answer")
    expect(screen.getByText('Prompt a?')).toBeInTheDocument()
  })

  it('nothing due → empty state', async () => {
    getDueReviewQuestions.mockResolvedValue({ totalDue: 0, items: [] })
    renderIn(<ChapterQuestionReviewPage />)
    expect(await screen.findByText('No chapter questions due right now.')).toBeInTheDocument()
  })
})

describe('ChapterQuestionsCard', () => {
  it('shows the due count and a Start link to the session', async () => {
    getDueReviewQuestions.mockResolvedValue({ totalDue: 6, items: [q('a')] })
    renderIn(<ChapterQuestionsCard />)
    expect(await screen.findByText('6 due')).toBeInTheDocument()
    expect(screen.getByText('Chapter questions')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Start' })).toHaveAttribute('href', '/en/review/questions')
    expect(getDueReviewQuestions).toHaveBeenCalledWith(1)
  })

  it('renders nothing when nothing is due', async () => {
    getDueReviewQuestions.mockResolvedValue({ totalDue: 0, items: [] })
    const { container } = renderIn(<ChapterQuestionsCard />)
    await waitFor(() => expect(getDueReviewQuestions).toHaveBeenCalled())
    await Promise.resolve()
    expect(container).toBeEmptyDOMElement()
  })
})
