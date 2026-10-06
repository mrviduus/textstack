import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock text anchoring: findTextByAnchor returns a fake range; createTextAnchor a stub.
const fakeRange = { getBoundingClientRect: () => ({ top: 100, height: 20, width: 50 }) }
// Rest-param signatures so the passthrough spread below type-checks; the closure
// keeps access lazy (vi.mock factories are hoisted above these declarations).
const findTextByAnchor = vi.fn((..._a: unknown[]) => fakeRange)
const createTextAnchor = vi.fn((..._a: unknown[]) => ({
  prefix: '', exact: 'x', suffix: '', startOffset: 0, endOffset: 1, chapterId: 'c1',
}))
vi.mock('../../lib/textAnchor', () => ({
  findTextByAnchor: (...a: unknown[]) => findTextByAnchor(...a),
  createTextAnchor: (...a: unknown[]) => createTextAnchor(...a),
  highlightChapterKey: (h: { anchor: { chapterId?: string } }) => h.anchor.chapterId ?? null,
  isCacheChapterKey: (id: string) => id.includes(':'),
}))

import { useHighlightEdit } from '../useHighlightEdit'
import type { StoredHighlight, TextAnchor } from '../../lib/offlineDb'

function hl(id: string): StoredHighlight {
  const anchor: TextAnchor = {
    prefix: '', exact: id, suffix: '', startOffset: 0, endOffset: 1, chapterId: 'c1',
  }
  return {
    id, editionId: 'e1', chapterId: 'c1', anchor, color: 'yellow',
    selectedText: id, syncStatus: 'synced', version: 1, createdAt: 1, updatedAt: 1,
  }
}

const addHighlight = vi.fn(async () => hl('new'))
const updateHighlight = vi.fn(async () => null)
const removeHighlight = vi.fn(async () => {})

function makeContainer() {
  return { current: document.createElement('div') } as React.RefObject<HTMLElement | null>
}

beforeEach(() => {
  findTextByAnchor.mockClear()
  addHighlight.mockClear(); updateHighlight.mockClear(); removeHighlight.mockClear()
  // rAF → run synchronously so the scroll effect completes within act().
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
  vi.stubGlobal('scrollTo', vi.fn())
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
})

describe('useHighlightEdit — hoisted highlights (no internal load)', () => {
  it('operates on the passed-in highlights + mutators', async () => {
    const containerRef = makeContainer()
    const { result } = renderHook(() =>
      useHighlightEdit({
        highlights: [hl('a')],
        addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef,
      }),
    )
    // createHighlightFromSelection routes to the injected addHighlight (not an
    // internal useHighlights instance — proves the load was hoisted out).
    const range = document.createRange()
    await act(async () => {
      await result.current.createHighlightFromSelection(range, 'hello', 'green')
    })
    expect(addHighlight).toHaveBeenCalledTimes(1)
  })

  it('does not save a highlight under an offline cache key (editionId:slug)', async () => {
    createTextAnchor.mockReturnValueOnce({
      prefix: '', exact: 'x', suffix: '', startOffset: 0, endOffset: 1, chapterId: 'ed-1:2-ii',
    })
    const { result } = renderHook(() =>
      useHighlightEdit({
        highlights: [], addHighlight, updateHighlight, removeHighlight,
        chapterId: 'ed-1:2-ii', containerRef: makeContainer(),
      }),
    )
    await act(async () => {
      await result.current.createHighlightFromSelection(document.createRange(), 'x', 'green')
    })
    expect(addHighlight).not.toHaveBeenCalled()
  })

  it('delete routes to the injected removeHighlight', async () => {
    const containerRef = makeContainer()
    const { result } = renderHook(() =>
      useHighlightEdit({
        highlights: [hl('a')],
        addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef,
      }),
    )
    act(() => {
      result.current.handleHighlightClick(hl('a'), new DOMRect())
    })
    await act(async () => {
      await result.current.handleHighlightDelete()
    })
    expect(removeHighlight).toHaveBeenCalledWith('a')
  })
})

describe('useHighlightEdit — nonce-driven drawer jump', () => {
  it('re-fires the scroll when the nonce changes (same id)', () => {
    const containerRef = makeContainer()
    const { rerender } = renderHook(
      ({ scrollToHl }) =>
        useHighlightEdit({
          highlights: [hl('a')],
          addHighlight, updateHighlight, removeHighlight,
          chapterId: 'c1', containerRef, scrollToHl,
        }),
      { initialProps: { scrollToHl: { id: 'a', nonce: 1 } } },
    )
    expect(findTextByAnchor).toHaveBeenCalledTimes(1)

    // Same nonce → no re-fire.
    rerender({ scrollToHl: { id: 'a', nonce: 1 } })
    expect(findTextByAnchor).toHaveBeenCalledTimes(1)

    // New nonce, same id → re-fires.
    rerender({ scrollToHl: { id: 'a', nonce: 2 } })
    expect(findTextByAnchor).toHaveBeenCalledTimes(2)
  })

  it('does nothing when scrollToHl is null', () => {
    const containerRef = makeContainer()
    renderHook(() =>
      useHighlightEdit({
        highlights: [hl('a')],
        addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef, scrollToHl: null,
      }),
    )
    expect(findTextByAnchor).not.toHaveBeenCalled()
  })

  it('navigates to the highlight chapter when the anchor is not mounted (miss)', () => {
    // findTextByAnchor misses → highlight lives in an unmounted chapter.
    findTextByAnchor.mockReturnValueOnce(null as unknown as typeof fakeRange)
    const onNavigateToHighlight = vi.fn()
    const containerRef = makeContainer()
    const { unmount } = renderHook(() =>
      useHighlightEdit({
        highlights: [hl('a')],
        addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef,
        scrollToHl: { id: 'a', nonce: 1 },
        onNavigateToHighlight,
      }),
    )
    expect(onNavigateToHighlight).toHaveBeenCalledTimes(1)
    expect(onNavigateToHighlight.mock.calls[0][0].id).toBe('a')
    unmount() // clears the pending retry poll
  })
})
