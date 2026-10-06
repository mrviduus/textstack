import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { VocabOverlayLayer } from '../VocabOverlayLayer'
import type { VocabMap } from '../../../hooks/useReaderVocabulary'

class NoopResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function installRangeStub(rects: { left: number; top: number; width: number; height: number }) {
  const orig = (Range.prototype as unknown as { getClientRects?: () => DOMRectList }).getClientRects
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: function () {
      const r = {
        ...rects,
        right: rects.left + rects.width,
        bottom: rects.top + rects.height,
      } as DOMRect
      return {
        length: 1,
        item: (i: number) => (i === 0 ? r : null),
        [Symbol.iterator]: function* () {
          yield r
        },
      } as unknown as DOMRectList
    },
  })
  return () => {
    if (orig) {
      Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: orig })
    }
  }
}

function Host({ html, vocabMap, active = null }: {
  html: string
  vocabMap: VocabMap
  active?: { word: string; translation: string | null } | null
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const ref = { current: el } as React.RefObject<HTMLElement | null>
  return (
    <>
      <div ref={setEl} dangerouslySetInnerHTML={{ __html: html }} />
      <VocabOverlayLayer containerRef={ref} vocabMap={vocabMap} activeBubble={active} />
    </>
  )
}

describe('VocabOverlayLayer', () => {
  const originalRO = globalThis.ResizeObserver
  let restoreRange: (() => void) | null = null

  beforeEach(() => {
    globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver
    restoreRange = installRangeStub({ left: 10, top: 20, width: 40, height: 16 })
  })
  afterEach(() => {
    globalThis.ResizeObserver = originalRO
    restoreRange?.()
    cleanup()
  })

  it('renders overlay host + SVG', () => {
    const vocab: VocabMap = new Map([['hello', { stage: 0, id: 'w1' }]])
    const { container } = render(<Host html="<p>hello world</p>" vocabMap={vocab} />)
    expect(container.querySelector('div[data-vocab-overlay-host="true"]')).not.toBeNull()
    expect(container.querySelector('svg[data-reader-overlay="true"]')).not.toBeNull()
  })

  it('draws a <g> per saved vocab match', () => {
    const vocab: VocabMap = new Map([
      ['hello', { stage: 0, id: 'w1' }],
      ['world', { stage: 3, id: 'w2' }],
    ])
    const { container } = render(<Host html="<p>hello world hello</p>" vocabMap={vocab} />)
    const groups = container.querySelectorAll('svg[data-reader-overlay="true"] > g')
    // 'hello' appears twice, 'world' once → 3 matches.
    expect(groups.length).toBe(3)
  })

  it('does not draw anything when vocab map is empty and no active bubble', () => {
    const { container } = render(<Host html="<p>hello world</p>" vocabMap={new Map()} />)
    const groups = container.querySelectorAll('svg[data-reader-overlay="true"] > g')
    expect(groups.length).toBe(0)
  })

  it('highlights unsaved active-bubble word preview', () => {
    const { container } = render(
      <Host
        html="<p>hello world</p>"
        vocabMap={new Map()}
        active={{ word: 'hello', translation: 'привет' }}
      />,
    )
    const groups = container.querySelectorAll('svg[data-reader-overlay="true"] > g')
    expect(groups.length).toBe(1)
  })

  it('re-maps when the chapter DOM is swapped under the same layer', async () => {
    const vocab: VocabMap = new Map([
      ['hello', { stage: 0, id: 'w1' }],
      ['world', { stage: 0, id: 'w2' }],
    ])
    const { container, rerender } = render(<Host html="<p>hello</p>" vocabMap={vocab} />)
    const groups = () => container.querySelectorAll('svg[data-reader-overlay="true"] > g').length
    expect(groups()).toBe(1)
    rerender(<Host html="<p>world hello world</p>" vocabMap={vocab} />)
    await waitFor(() => expect(groups()).toBe(3))
  })

  it('cleans up SVG on unmount', () => {
    const vocab: VocabMap = new Map([['hello', { stage: 0, id: 'w1' }]])
    const { container, unmount } = render(<Host html="<p>hello</p>" vocabMap={vocab} />)
    expect(container.querySelector('svg[data-reader-overlay="true"]')).not.toBeNull()
    unmount()
    expect(container.querySelector('svg[data-reader-overlay="true"]')).toBeNull()
  })
})
