import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { BookInsight } from '@textstack/shared'

vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

// The section is presentational: the page's useBookReviews owns the list and the delete.
const onRemove = vi.fn()

import { BookInsightsSection } from '../BookInsightsSection'

/** Mirrors the page: owns the list, drops the row only when onRemove resolves (as useBookReviews does). */
function Host({ initial }: { initial: unknown[] }) {
  const [list, setList] = useState(initial as BookInsight[])
  const remove = async (id: string) => { await onRemove(id); setList(l => l.filter(i => i.id !== id)) }
  return <BookInsightsSection insights={list} onRemove={remove} userBookId="b1" />
}

const insight = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'i1', editionId: null, userBookId: 'b1',
  chapterSlug: null, chapterNumber: null, chapterTitle: null,
  text: 'A conclusion.', question: null, source: 'mcp',
  createdAt: '2026-01-01T00:00:00+00:00', updatedAt: '2026-01-01T00:00:00+00:00',
  ...over,
})

beforeEach(() => { onRemove.mockReset() })
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

  it('removing a note takes the row away, and the section with it when it was the last one', async () => {
    // The failure this exists for: a conclusion filed against the WRONG chapter. The assistant only
    // ever replaces its own row for the chapter it meant, so nothing revisits the mistake — the
    // reader has to be able to remove it, and see that it went.
    onRemove.mockResolvedValue(undefined)

    const { container } = render(<Host initial={[insight({ chapterTitle: 'Replication', chapterSlug: 'r' })]} />)
    await waitFor(() => expect(screen.getByText('Replication')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('library.insights.remove'))

    await waitFor(() => expect(container.querySelector('.book-insights')).toBeNull())
    expect(onRemove).toHaveBeenCalledWith('i1')
  })

  it('keeps the row when the server refuses — it is still there', async () => {
    // Silence on failure is right for this panel, but silence must not mean "pretend it is gone".
    // Dropping it from the list on a failed delete would show the reader a book with a note they
    // would find again on the next load.
    onRemove.mockRejectedValue(new Error('nope'))

    render(<Host initial={[insight({ chapterTitle: 'Replication', chapterSlug: 'r' })]} />)
    await waitFor(() => expect(screen.getByText('Replication')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('library.insights.remove'))

    await waitFor(() => expect(onRemove).toHaveBeenCalled())
    expect(screen.getByText('Replication')).toBeTruthy()
  })
})
