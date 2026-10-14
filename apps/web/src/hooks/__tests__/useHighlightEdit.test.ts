import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { Locator, ReaderEngine } from '@textstack/reader-engine'
import { useHighlightEdit } from '../useHighlightEdit'
import { setMountedEngine, unmountEngine } from '../../lib/readerEngine'
import type { StoredHighlight, TextAnchor } from '../../lib/offlineDb'

// Jumps go through the engine's goTo (ADR-025); a highlight it cannot show is a miss, never a window scroll.
const HREF = 'ch-1'

function hl(id: string, chapterId = 'c1'): StoredHighlight {
  const anchor: TextAnchor = {
    prefix: 'He ', exact: id, suffix: ' walked.', startOffset: 3, endOffset: 3 + id.length, chapterId,
  }
  return {
    id, editionId: 'e1', chapterId, anchor, color: 'yellow',
    selectedText: id, syncStatus: 'synced', version: 1, createdAt: 1, updatedAt: 1,
  }
}
const selected: Locator = {
  href: HREF, type: 'text/html', locations: { charOffset: 3 },
  text: { before: 'He ', highlight: 'hello', after: ' walked.' },
}

const addHighlight = vi.fn(async () => hl('new'))
const updateHighlight = vi.fn(async () => null)
const removeHighlight = vi.fn(async () => {})
const goTo = vi.fn(async () => 'exact')
const engine = { goTo, current: () => null } as unknown as ReaderEngine

function makeContainer() {
  return { current: document.createElement('div') } as React.RefObject<HTMLElement | null>
}

beforeEach(() => {
  addHighlight.mockClear(); updateHighlight.mockClear(); removeHighlight.mockClear(); goTo.mockClear()
  // rAF → run synchronously so the scroll effect completes within act().
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  setMountedEngine({ engine, href: HREF })
})
afterEach(() => {
  unmountEngine(engine)
  vi.unstubAllGlobals()
})

describe('useHighlightEdit — hoisted highlights (no internal load)', () => {
  it('operates on the passed-in highlights + mutators', async () => {
    const { result } = renderHook(() =>
      useHighlightEdit({
        highlights: [hl('a')],
        addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef: makeContainer(), engineHref: HREF,
      }),
    )
    // createHighlightFromSelection routes to the injected addHighlight (not an
    // internal useHighlights instance — proves the load was hoisted out).
    await act(async () => {
      await result.current.createHighlightFromSelection('hello', 'green', selected)
    })
    expect(addHighlight).toHaveBeenCalledTimes(1)
  })

  it('does not save a highlight under an offline cache key (editionId:slug)', async () => {
    const { result } = renderHook(() =>
      useHighlightEdit({
        highlights: [], addHighlight, updateHighlight, removeHighlight,
        chapterId: 'ed-1:2-ii', containerRef: makeContainer(), engineHref: HREF,
      }),
    )
    await act(async () => {
      await result.current.createHighlightFromSelection('hello', 'green', selected)
    })
    expect(addHighlight).not.toHaveBeenCalled()
  })

  it('delete routes to the injected removeHighlight', async () => {
    const { result } = renderHook(() =>
      useHighlightEdit({
        highlights: [hl('a')],
        addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef: makeContainer(),
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
  it('re-fires the jump when the nonce changes (same id)', () => {
    const { rerender } = renderHook(
      ({ scrollToHl }) =>
        useHighlightEdit({
          highlights: [hl('a')],
          addHighlight, updateHighlight, removeHighlight,
          chapterId: 'c1', containerRef: makeContainer(), scrollToHl, engineHref: HREF,
        }),
      { initialProps: { scrollToHl: { id: 'a', nonce: 1 } } },
    )
    expect(goTo).toHaveBeenCalledTimes(1)

    // Same nonce → no re-fire.
    rerender({ scrollToHl: { id: 'a', nonce: 1 } })
    expect(goTo).toHaveBeenCalledTimes(1)

    // New nonce, same id → re-fires.
    rerender({ scrollToHl: { id: 'a', nonce: 2 } })
    expect(goTo).toHaveBeenCalledTimes(2)
  })

  it('does nothing when scrollToHl is null', () => {
    renderHook(() =>
      useHighlightEdit({
        highlights: [hl('a')],
        addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef: makeContainer(), scrollToHl: null, engineHref: HREF,
      }),
    )
    expect(goTo).not.toHaveBeenCalled()
  })

  it('navigates to the highlight chapter when it is not the one shown (miss)', () => {
    const onNavigateToHighlight = vi.fn()
    const { unmount } = renderHook(() =>
      useHighlightEdit({
        highlights: [hl('a', 'c9')],
        addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef: makeContainer(), engineHref: HREF,
        scrollToHl: { id: 'a', nonce: 1 },
        onNavigateToHighlight,
      }),
    )
    expect(goTo).not.toHaveBeenCalled()
    expect(onNavigateToHighlight).toHaveBeenCalledTimes(1)
    expect(onNavigateToHighlight.mock.calls[0][0].id).toBe('a')
    unmount()
  })

  it('no engine showing the chapter: the jump does nothing — never a window scroll', () => {
    renderHook(() =>
      useHighlightEdit({
        highlights: [hl('a')],
        addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef: makeContainer(), engineHref: null,
        scrollToHl: { id: 'a', nonce: 1 },
      }),
    )
    expect(goTo).not.toHaveBeenCalled()
    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})

describe('useHighlightEdit — ?highlight= link reports its outcome', () => {
  type Opts = Parameters<typeof useHighlightEdit>[0]
  it('found → the engine goes there centred and it reports true', async () => {
    const done = vi.fn()
    renderHook(() =>
      useHighlightEdit({
        highlights: [hl('a')], addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef: makeContainer(), engineHref: HREF,
        scrollToHighlightId: 'a', highlightLinkReady: true, onHighlightLinkDone: done,
      } as Opts),
    )
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(true))
    expect(goTo).toHaveBeenCalledWith(expect.objectContaining({ href: HREF }), { align: 'center' })
  })

  it('not in the list → reports false (the reader falls back to restore)', async () => {
    const done = vi.fn()
    renderHook(() =>
      useHighlightEdit({
        highlights: [hl('a')], addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef: makeContainer(), engineHref: HREF,
        scrollToHighlightId: 'gone', highlightLinkReady: true, onHighlightLinkDone: done,
      } as Opts),
    )
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(false))
  })

  it('waits until ready (highlights + chapter loaded)', () => {
    const done = vi.fn()
    renderHook(() =>
      useHighlightEdit({
        highlights: [], addHighlight, updateHighlight, removeHighlight,
        chapterId: 'c1', containerRef: makeContainer(), engineHref: HREF,
        scrollToHighlightId: 'a', highlightLinkReady: false, onHighlightLinkDone: done,
      } as Opts),
    )
    expect(done).not.toHaveBeenCalled()
  })
})

describe('useHighlightEdit — ?highlight= link to a PDF highlight', () => {
  type Opts = Parameters<typeof useHighlightEdit>[0]
  const pdf = (): StoredHighlight => ({
    ...hl('p'), chapterId: '',
    anchor: { v: 1, kind: 'pdf', page: 3, rects: [{ x: 1, y: 1, w: 1, h: 1 }], exact: 'p' } as unknown as StoredHighlight['anchor'],
  })
  it('reflow (PDF fell back to text): nothing jumps → not found, the normal restore runs', async () => {
    const done = vi.fn()
    renderHook(() => useHighlightEdit({
      highlights: [pdf()], addHighlight, updateHighlight, removeHighlight, chapterId: 'c1', containerRef: makeContainer(),
      scrollToHighlightId: 'p', highlightLinkReady: true, onHighlightLinkDone: done, pdfLinkJumps: false,
    } as Opts))
    await vi.waitFor(() => expect(done).toHaveBeenCalled())
    expect(done).toHaveBeenCalledWith(false)
  })
  it('Original layout: the page jump positions it → landed', async () => {
    const done = vi.fn()
    renderHook(() => useHighlightEdit({
      highlights: [pdf()], addHighlight, updateHighlight, removeHighlight, chapterId: 'c1', containerRef: makeContainer(),
      scrollToHighlightId: 'p', highlightLinkReady: true, onHighlightLinkDone: done, pdfLinkJumps: true,
    } as Opts))
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(true))
  })
})
