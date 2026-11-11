import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ReaderTocDrawer, sortHighlightsByPosition } from '../ReaderTocDrawer'
import type { StoredHighlight, TextAnchor } from '../../../lib/offlineDb'
import type { PdfAnchor } from '@textstack/shared'

function reflowHl(id: string, startOffset: number, extra?: Partial<StoredHighlight>): StoredHighlight {
  const anchor: TextAnchor = {
    prefix: '',
    exact: `text-${id}`,
    suffix: '',
    startOffset,
    endOffset: startOffset + 5,
    chapterId: 'c1',
  }
  return {
    id,
    editionId: 'e1',
    chapterId: 'c1',
    anchor,
    color: 'yellow',
    selectedText: `text-${id}`,
    syncStatus: 'synced',
    version: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  }
}

function pdfHl(id: string, page: number, y: number, extra?: Partial<StoredHighlight>): StoredHighlight {
  const anchor: PdfAnchor = {
    v: 1,
    kind: 'pdf',
    page,
    rects: [{ x: 10, y, w: 20, h: 8 }],
    exact: `pdf-${id}`,
  }
  return {
    id,
    editionId: '',
    chapterId: '',
    userBookId: 'ub1',
    anchor,
    color: 'green',
    selectedText: `pdf-${id}`,
    syncStatus: 'synced',
    version: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  }
}

describe('sortHighlightsByPosition', () => {
  it('sorts reflow highlights by text startOffset', () => {
    const sorted = sortHighlightsByPosition([
      reflowHl('b', 200),
      reflowHl('a', 50),
      reflowHl('c', 300),
    ])
    expect(sorted.map((h) => h.id)).toEqual(['a', 'b', 'c'])
  })

  it('sorts PDF highlights by page then rect y', () => {
    const sorted = sortHighlightsByPosition([
      pdfHl('p2y10', 2, 10),
      pdfHl('p1y90', 1, 90),
      pdfHl('p1y10', 1, 10),
    ])
    expect(sorted.map((h) => h.id)).toEqual(['p1y10', 'p1y90', 'p2y10'])
  })

  it('falls back to newest-first for a mixed reflow/PDF list', () => {
    const sorted = sortHighlightsByPosition([
      reflowHl('old', 50, { createdAt: 100 }),
      pdfHl('new', 1, 10, { createdAt: 999 }),
    ])
    expect(sorted.map((h) => h.id)).toEqual(['new', 'old'])
  })

  it('does not mutate the input array', () => {
    const input = [reflowHl('b', 200), reflowHl('a', 50)]
    sortHighlightsByPosition(input)
    expect(input.map((h) => h.id)).toEqual(['b', 'a'])
  })
})

function renderDrawer(extra?: Partial<React.ComponentProps<typeof ReaderTocDrawer>>) {
  return render(
    <MemoryRouter>
      <ReaderTocDrawer
        open
        chapters={[]}
        currentChapterIdentifier=""
        bookmarks={[]}
        getChapterUrl={(id) => `/read/${id}`}
        useLocalizedLink={false}
        onClose={() => {}}
        onRemoveBookmark={() => {}}
        {...extra}
      />
    </MemoryRouter>,
  )
}

describe('ReaderTocDrawer — Highlights tab', () => {
  it('shows the empty state when there are no highlights', () => {
    renderDrawer({ highlights: [] })
    fireEvent.click(screen.getByRole('button', { name: /^Highlights/ }))
    expect(screen.getByText(/No highlights yet/)).toBeTruthy()
  })

  it('lists highlights sorted by position with note text', () => {
    renderDrawer({
      highlights: [reflowHl('b', 200, { noteText: 'my note' }), reflowHl('a', 50)],
    })
    fireEvent.click(screen.getByRole('button', { name: /^Highlights/ }))
    expect(screen.getByText('text-a')).toBeTruthy()
    expect(screen.getByText('text-b')).toBeTruthy()
    expect(screen.getByText('my note')).toBeTruthy()
  })

  it('fires onHighlightSelect + onClose when a highlight is clicked', () => {
    const onHighlightSelect = vi.fn()
    const onClose = vi.fn()
    renderDrawer({ highlights: [reflowHl('a', 50)], onHighlightSelect, onClose })
    fireEvent.click(screen.getByRole('button', { name: /^Highlights/ }))
    fireEvent.click(screen.getByText('text-a'))
    expect(onHighlightSelect).toHaveBeenCalledTimes(1)
    expect(onHighlightSelect.mock.calls[0][0].id).toBe('a')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('ReaderTocDrawer — Contents numbering', () => {
  // chapterNumber is an ordering key (editions start at 0, uploads at 1 or 2): the list shows the place.
  it.each([[0], [1], [2]])('contents_ChapterNumbersFrom%i_ShowOneTwo', (first) => {
    const { container } = renderDrawer({
      chapters: [
        { id: 'a', identifier: 'a', chapterNumber: first, title: 'Alpha' },
        { id: 'b', identifier: 'b', chapterNumber: first + 1, title: 'Beta' },
      ] as React.ComponentProps<typeof ReaderTocDrawer>['chapters'],
    })
    const numbers = [...container.querySelectorAll('.reader-toc-drawer__number')].map((n) => n.textContent)
    expect(numbers).toEqual(['1', '2'])
  })
})
