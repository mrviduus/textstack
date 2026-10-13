import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
})
