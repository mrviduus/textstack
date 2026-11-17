import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import type { BookInsight } from '@textstack/shared'

vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { BookInsightsSection } from '../BookInsightsSection'

// The section is presentational: the page's useBookReviews owns the list.
const Host = ({ initial }: { initial: unknown[] }) => <BookInsightsSection insights={initial as BookInsight[]} />

const insight = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'i1', editionId: null, userBookId: 'b1',
  chapterSlug: null, chapterNumber: null, chapterTitle: null,
  text: 'A conclusion.', question: null, source: 'mcp',
  createdAt: '2026-01-01T00:00:00+00:00', updatedAt: '2026-01-01T00:00:00+00:00',
  ...over,
})

afterEach(() => cleanup())

describe('BookInsightsSection', () => {
  it('renders nothing when the book has no insights', async () => {
    // Not an empty state: this panel would otherwise sit on every book screen
    // forever, teaching a feature you can only reach by connecting an assistant.
    const { container } = render(<Host initial={[]} />)
    expect(container.querySelector('.book-insights')).toBeNull()
  })

  it('labels a book-level insight with the whole-book string', async () => {
    render(<Host initial={[insight()]} />)
    expect(await screen.findByText('library.insights.wholeBook')).toBeInTheDocument()
  })

  it('labels a chapter by title, never by number', async () => {
    // chapterNumber orders; it does not display. A catalog page renders
    // chapterNumber + 1 and an upload renders it as-is, so a number printed here
    // is off by one on exactly one of them.
    const { container } = render(<Host initial={[
      insight({ chapterSlug: '5-replication', chapterNumber: 4, chapterTitle: 'Replication' }),
    ]} />)
    // Assert INSIDE waitFor: it only retries when the callback throws, and a
    // querySelector that finds nothing returns null quietly — the `!` was lying
    // to the compiler and the test passed a null straight through.
    await waitFor(() => {
      expect(container.querySelector('.book-insights__scope')?.textContent).toBe('Replication')
    })
  })

  it('falls back to the slug when a re-ingest left the title unresolvable', async () => {
    const { container } = render(<Host initial={[
      insight({ chapterSlug: '5-replication', chapterNumber: null, chapterTitle: null }),
    ]} />)
    await waitFor(() => {
      expect(container.querySelector('.book-insights__scope')?.textContent).toBe('5-replication')
    })
  })

  it('shows the question, which is what makes an answer worth returning to', async () => {
    render(<Host initial={[insight({ question: 'why w + r > n?' })]} />)
    expect(await screen.findByText('why w + r > n?')).toBeInTheDocument()
  })

  it('renders the markdown body as markup, not as literal asterisks', async () => {
    const { container } = render(<Host initial={[insight({ text: 'Quorums are about **overlap**.' })]} />)
    await waitFor(() => expect(container.querySelector('.book-insights__body strong')).toBeTruthy())
    expect(container.textContent).not.toContain('**')
  })

  it('does not interpret raw HTML in assistant output', async () => {
    // react-markdown parses no raw HTML (no rehype-raw) and nothing here uses
    // dangerouslySetInnerHTML. Insight text is written by a model over MCP.
    const { container } = render(<Host initial={[insight({ text: '<img src=x onerror="alert(1)">' })]} />)
    await waitFor(() => expect(container.querySelector('.book-insights')).toBeTruthy())
    expect(container.querySelector('img')).toBeNull()
  })
})
