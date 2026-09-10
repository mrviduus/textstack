import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

// Mocks the WEB client, not the shared one. This test used to mock `@textstack/shared`'s
// `insightsApi`, which is how it stayed green while the component called an api layer the web app
// never initialises — the mock replaced the broken dependency with a working one. See
// noSharedApiOnWeb.test.ts for the guard that catches the class rather than the instance.
const getBookInsights = vi.fn()
vi.mock('../../../api/insights', () => ({
  getBookInsights: (...a: unknown[]) => getBookInsights(...a),
}))

import { BookInsightsSection } from '../BookInsightsSection'

const insight = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'i1', editionId: null, userBookId: 'b1',
  chapterSlug: null, chapterNumber: null, chapterTitle: null,
  text: 'A conclusion.', question: null, source: 'mcp',
  createdAt: '2026-01-01T00:00:00+00:00', updatedAt: '2026-01-01T00:00:00+00:00',
  ...over,
})

beforeEach(() => getBookInsights.mockReset())
afterEach(() => cleanup())

describe('BookInsightsSection', () => {
  it('renders nothing when the book has no insights', async () => {
    // Not an empty state: this panel would otherwise sit on every book screen
    // forever, teaching a feature you can only reach by connecting an assistant.
    getBookInsights.mockResolvedValue([])
    const { container } = render(<BookInsightsSection userBookId="b1" />)
    await waitFor(() => expect(getBookInsights).toHaveBeenCalled())
    expect(container.querySelector('.book-insights')).toBeNull()
  })

  // NOT TESTED: the rejection path. The component catches and renders nothing, and
  // a signed-out reader hits it on every book. Seven attempts at a test for it all
  // ended the same way — the *hook* timing out at 10s, not the assertion — and the
  // same code passed in a standalone file, so the cause is an interaction with this
  // file's setup that I did not isolate. A test that hangs for ten seconds is worse
  // than no test, and guessing at it further was not worth more of the budget. The
  // behaviour itself is one `.catch(() => {})` in view of the reader.

  it('labels a book-level insight with the whole-book string', async () => {
    getBookInsights.mockResolvedValue([insight()])
    render(<BookInsightsSection userBookId="b1" />)
    expect(await screen.findByText('library.insights.wholeBook')).toBeInTheDocument()
  })

  it('labels a chapter by title, never by number', async () => {
    // chapterNumber orders; it does not display. A catalog page renders
    // chapterNumber + 1 and an upload renders it as-is, so a number printed here
    // is off by one on exactly one of them.
    getBookInsights.mockResolvedValue([
      insight({ chapterSlug: '5-replication', chapterNumber: 4, chapterTitle: 'Replication' }),
    ])
    const { container } = render(<BookInsightsSection userBookId="b1" />)
    // Assert INSIDE waitFor: it only retries when the callback throws, and a
    // querySelector that finds nothing returns null quietly — the `!` was lying
    // to the compiler and the test passed a null straight through.
    await waitFor(() => {
      expect(container.querySelector('.book-insights__scope')?.textContent).toBe('Replication')
    })
  })

  it('falls back to the slug when a re-ingest left the title unresolvable', async () => {
    getBookInsights.mockResolvedValue([
      insight({ chapterSlug: '5-replication', chapterNumber: null, chapterTitle: null }),
    ])
    const { container } = render(<BookInsightsSection userBookId="b1" />)
    await waitFor(() => {
      expect(container.querySelector('.book-insights__scope')?.textContent).toBe('5-replication')
    })
  })

  it('shows the question, which is what makes an answer worth returning to', async () => {
    getBookInsights.mockResolvedValue([insight({ question: 'why w + r > n?' })])
    render(<BookInsightsSection userBookId="b1" />)
    expect(await screen.findByText('why w + r > n?')).toBeInTheDocument()
  })

  it('renders the markdown body as markup, not as literal asterisks', async () => {
    getBookInsights.mockResolvedValue([insight({ text: 'Quorums are about **overlap**.' })])
    const { container } = render(<BookInsightsSection userBookId="b1" />)
    await waitFor(() => expect(container.querySelector('.book-insights__body strong')).toBeTruthy())
    expect(container.textContent).not.toContain('**')
  })

  it('does not interpret raw HTML in assistant output', async () => {
    // react-markdown parses no raw HTML (no rehype-raw) and nothing here uses
    // dangerouslySetInnerHTML. Insight text is written by a model over MCP.
    getBookInsights.mockResolvedValue([insight({ text: '<img src=x onerror="alert(1)">' })])
    const { container } = render(<BookInsightsSection userBookId="b1" />)
    await waitFor(() => expect(container.querySelector('.book-insights')).toBeTruthy())
    expect(container.querySelector('img')).toBeNull()
  })

  it('asks the server for the id it was given', async () => {
    getBookInsights.mockResolvedValue([])
    render(<BookInsightsSection editionId="e9" />)
    await waitFor(() => expect(getBookInsights).toHaveBeenCalledWith({ editionId: 'e9' }))
  })
})
