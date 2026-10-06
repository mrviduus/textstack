import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { createRef } from 'react'
import { ReaderSection, type ReaderSectionHandle } from '../ReaderSection'
import type { ReaderSettings } from '../../../hooks/useReaderSettings'

const settings: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.6,
  fontFamily: 'serif',
  textAlign: 'left',
} as unknown as ReaderSettings

class NoopResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

describe('ReaderSection', () => {
  const originalRO = globalThis.ResizeObserver

  beforeEach(() => {
    globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver
  })
  afterEach(() => {
    globalThis.ResizeObserver = originalRO
    cleanup()
  })

  it('renders chapter html inside an article', () => {
    const { container } = render(
      <ReaderSection
        chapterId="ch1"
        chapterIndex={0}
        html="<p>Hello world</p>"
        settings={settings}
      />,
    )
    const article = container.querySelector('article')!
    expect(article.getAttribute('data-chapter-id')).toBe('ch1')
    expect(article.textContent).toBe('Hello world')
  })

  // A re-render with the same html must not rebuild the chapter DOM: every live
  // Range (highlights, vocab marks, the selection) points into those nodes.
  it('keeps the chapter DOM across re-renders with the same html', () => {
    const { container, rerender } = render(
      <ReaderSection chapterId="ch1" chapterIndex={0} html="<p>Hello world</p>" settings={settings} />,
    )
    const text = container.querySelector('p')!.firstChild
    rerender(
      <ReaderSection chapterId="ch1" chapterIndex={0} html="<p>Hello world</p>" settings={{ ...settings, fontSize: 22 }} />,
    )
    expect(container.querySelector('p')!.firstChild).toBe(text)
  })

  it('mounts an SVG overlay sibling', () => {
    const { container } = render(
      <ReaderSection chapterId="ch1" chapterIndex={0} html="<p>x</p>" settings={settings} />,
    )
    const svg = container.querySelector('svg[data-reader-overlay="true"]')
    expect(svg).not.toBeNull()
  })

  it('exposes the article + overlayer via ref', () => {
    const ref = createRef<ReaderSectionHandle>()
    render(
      <ReaderSection
        ref={ref}
        chapterId="ch1"
        chapterIndex={0}
        html="<p>x</p>"
        settings={settings}
      />,
    )
    expect(ref.current?.article).not.toBeNull()
    expect(ref.current?.overlayer).not.toBeNull()
  })

  it('omits the overlayer when overlayEnabled=false', () => {
    const ref = createRef<ReaderSectionHandle>()
    const { container } = render(
      <ReaderSection
        ref={ref}
        chapterId="ch1"
        chapterIndex={0}
        html="<p>x</p>"
        settings={settings}
        overlayEnabled={false}
      />,
    )
    expect(container.querySelector('svg[data-reader-overlay="true"]')).toBeNull()
    expect(ref.current?.overlayer).toBeNull()
  })

  it('dispatches reader-annotation-click when tap hits an annotation', () => {
    const ref = createRef<ReaderSectionHandle>()
    const { container } = render(
      <ReaderSection
        ref={ref}
        chapterId="ch1"
        chapterIndex={0}
        html="<p>Hello world</p>"
        settings={settings}
      />,
    )
    const article = container.querySelector('article')!
    const ov = ref.current!.overlayer!
    const range = document.createRange()
    range.selectNodeContents(article.querySelector('p')!)
    Object.defineProperty(range, 'getClientRects', {
      configurable: true,
      value: () =>
        ({
          length: 1,
          item: (i: number) =>
            i === 0
              ? ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 } as DOMRect)
              : null,
          [Symbol.iterator]: function* () {
            yield { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 } as DOMRect
          },
        }) as unknown as DOMRectList,
    })
    ov.add('user-hl:a', range, (rects) => {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      for (const r of Array.from(rects)) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        el.setAttribute('x', String(r.left))
        el.setAttribute('y', String(r.top))
        el.setAttribute('width', String(r.width))
        el.setAttribute('height', String(r.height))
        g.append(el)
      }
      return g
    })

    const handler = vi.fn()
    article.addEventListener('reader-annotation-click', handler as EventListener)
    article.dispatchEvent(
      new MouseEvent('click', { clientX: 50, clientY: 10, bubbles: true }),
    )
    expect(handler).toHaveBeenCalled()
    const event = handler.mock.calls[0][0] as CustomEvent<{ key: string }>
    expect(event.detail.key).toBe('user-hl:a')
  })
})
