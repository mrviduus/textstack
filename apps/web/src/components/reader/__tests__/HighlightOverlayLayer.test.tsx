import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { createRef, useEffect, useState } from 'react'
import { HighlightOverlayLayer } from '../HighlightOverlayLayer'
import { ReviewedMarksContext } from '../ReviewedMarks'
import type { StoredHighlight } from '../../../lib/offlineDb'

class NoopResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function makeHighlight(id: string, exact: string, color: StoredHighlight['color'] = 'yellow'): StoredHighlight {
  return {
    id,
    editionId: 'ed-1',
    chapterId: 'ch-1',
    anchor: {
      prefix: '',
      exact,
      suffix: '',
      startOffset: 0,
      endOffset: exact.length,
      chapterId: 'ch-1',
    },
    color,
    selectedText: exact,
    syncStatus: 'synced',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function stubRangeRects(rect: { left: number; top: number; width: number; height: number }) {
  const r = { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height } as DOMRect
  return {
    length: 1,
    item: (i: number) => (i === 0 ? r : null),
    [Symbol.iterator]: function* () {
      yield r
    },
  } as unknown as DOMRectList
}

// Patch Range.prototype.getClientRects so every Range in the container
// returns a single predictable rect. JSDOM otherwise returns length-0.
function installRangeStub(rects: { left: number; top: number; width: number; height: number }) {
  const orig = (Range.prototype as unknown as { getClientRects?: () => DOMRectList }).getClientRects
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: function () {
      return stubRangeRects(rects)
    },
  })
  const origBcr = (Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function () {
      return {
        ...rects,
        right: rects.left + rects.width,
        bottom: rects.top + rects.height,
      } as DOMRect
    },
  })
  return () => {
    if (orig) {
      Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: orig })
    } else {
      delete (Range.prototype as unknown as { getClientRects?: unknown }).getClientRects
    }
    if (origBcr) {
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: origBcr })
    }
  }
}

// Tiny host that captures the container ref so the layer can resolve anchors.
function Host({ html, highlights, onHighlightClick }: {
  html: string
  highlights: StoredHighlight[]
  onHighlightClick?: (h: StoredHighlight, rect: DOMRect) => void
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const ref = { current: el } as React.RefObject<HTMLElement | null>
  useEffect(() => {}, [el])
  return (
    <>
      <div ref={setEl} dangerouslySetInnerHTML={{ __html: html }} />
      <HighlightOverlayLayer
        highlights={highlights}
        containerRef={ref}
        onHighlightClick={onHighlightClick}
      />
    </>
  )
}

describe('HighlightOverlayLayer', () => {
  const originalRO = globalThis.ResizeObserver
  let restoreRange: (() => void) | null = null

  beforeEach(() => {
    globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver
    restoreRange = installRangeStub({ left: 10, top: 20, width: 80, height: 16 })
  })
  afterEach(() => {
    globalThis.ResizeObserver = originalRO
    restoreRange?.()
    cleanup()
  })

  it('renders the overlay host div with SVG inside', () => {
    const ref = createRef<HTMLDivElement>()
    const { container } = render(
      <div ref={ref}>
        <Host html="<p>Hello world</p>" highlights={[makeHighlight('h1', 'Hello')]} />
      </div>,
    )
    const host = container.querySelector('div[data-highlight-overlay="true"]')
    expect(host).not.toBeNull()
    const svg = host!.querySelector('svg[data-reader-overlay="true"]')
    expect(svg).not.toBeNull()
  })

  it('adds one <g> per highlight', () => {
    const highlights = [makeHighlight('h1', 'Hello'), makeHighlight('h2', 'world', 'green')]
    const { container } = render(<Host html="<p>Hello world</p>" highlights={highlights} />)
    const groups = container.querySelectorAll('svg[data-reader-overlay="true"] > g')
    expect(groups.length).toBe(2)
  })

  it('removes rects when highlights are dropped', () => {
    const { container, rerender } = render(
      <Host html="<p>Hello world</p>" highlights={[makeHighlight('h1', 'Hello'), makeHighlight('h2', 'world')]} />,
    )
    expect(container.querySelectorAll('svg[data-reader-overlay="true"] > g').length).toBe(2)
    rerender(<Host html="<p>Hello world</p>" highlights={[makeHighlight('h1', 'Hello')]} />)
    expect(container.querySelectorAll('svg[data-reader-overlay="true"] > g').length).toBe(1)
  })

  it('fires onHighlightClick when click lands inside a rect', () => {
    const onClick = vi.fn()
    const h = makeHighlight('h1', 'Hello')
    const { container } = render(
      <Host html="<p>Hello world</p>" highlights={[h]} onHighlightClick={onClick} />,
    )
    // Container = the div we dangerouslySetInnerHTML'd into. Find it.
    const wrapper = container.firstChild as HTMLElement
    // We installed rects at (10, 20) 80x16 — click inside.
    wrapper.dispatchEvent(
      new MouseEvent('click', { clientX: 50, clientY: 25, bubbles: true }),
    )
    expect(onClick).toHaveBeenCalled()
    const [highlight] = onClick.mock.calls[0]
    expect(highlight.id).toBe('h1')
  })

  it('does not fire onHighlightClick when click misses all rects', () => {
    const onClick = vi.fn()
    const { container } = render(
      <Host
        html="<p>Hello world</p>"
        highlights={[makeHighlight('h1', 'Hello')]}
        onHighlightClick={onClick}
      />,
    )
    const wrapper = container.firstChild as HTMLElement
    // Rects at (10,20) 80x16. Click at (500, 500) misses.
    wrapper.dispatchEvent(
      new MouseEvent('click', { clientX: 500, clientY: 500, bubbles: true }),
    )
    expect(onClick).not.toHaveBeenCalled()
  })

  it('draws a reviewed dot only for highlights a review cited; a tap still opens the highlight', () => {
    const onClick = vi.fn()
    const marks = {
      marks: new Map([['h2', { chapterSlug: 'ch', blockTitle: 'B', rule: 'R' }]]),
      reviewPath: (s: string) => `/r/${s}`,
    }
    const { container } = render(
      <ReviewedMarksContext.Provider value={marks}>
        <Host html="<p>Hello world</p>" highlights={[makeHighlight('h1', 'Hello'), makeHighlight('H2', 'world')]} onHighlightClick={onClick} />
      </ReviewedMarksContext.Provider>,
    )
    const dots = container.querySelectorAll('svg[data-reader-overlay="true"] > g.reviewed-mark circle')
    expect(dots).toHaveLength(1)
    // rect (10,20) 80x16 → r = 2.5 (clamped), cx = right + r + 1
    expect(dots[0].getAttribute('cx')).toBe(String(90 + 2.5 + 1))
    // Both entries share the stubbed rect; the topmost one is the reviewed mark — the click must still resolve.
    ;(container.firstChild as HTMLElement).dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 25, bubbles: true }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick.mock.calls[0][0].id).toBe('H2')
  })

  it('cleans up SVG on unmount', () => {
    const { container, unmount } = render(
      <Host html="<p>Hello world</p>" highlights={[makeHighlight('h1', 'Hello')]} />,
    )
    expect(container.querySelector('svg[data-reader-overlay="true"]')).not.toBeNull()
    unmount()
    expect(container.querySelector('svg[data-reader-overlay="true"]')).toBeNull()
  })
})
