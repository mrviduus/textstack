import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { ReaderSettings } from '../../../hooks/useReaderSettings'

// Phase 4 slice 1: ReaderSection hands the chapter to the engine, which renders it,
// registers for useReaderScrollSync, takes typography through setStyle, and turns a tap into onTap (#818).
import { ReaderSection } from '../ReaderSection'
import { mountedEngineFor } from '../../../lib/readerEngine'

const reportError = vi.fn()
vi.mock('../../../lib/sentry', () => ({ reportError: (...a: unknown[]) => reportError(...a) }))

const settings = { fontSize: 18, lineHeight: 1.6, fontFamily: 'serif', textAlign: 'left' } as unknown as ReaderSettings

class NoopResizeObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

/** The open has landed: settles the fonts wait and the frame (jsdom has rAF on a timer). */
const opened = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })

describe('ReaderSection with the engine', () => {
  const originalRO = globalThis.ResizeObserver
  beforeEach(() => {
    globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver
    // jsdom has none; the engine's default scroller is the page.
    Object.defineProperty(document, 'scrollingElement', { value: document.documentElement, configurable: true })
  })
  afterEach(() => {
    cleanup()
    globalThis.ResizeObserver = originalRO
  })

  it('engine_Open_RendersTheSanitisedChapter', async () => {
    const { container } = render(
      <ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html={'<p>Hello world</p><script>bad()</script>'} settings={settings} />,
    )
    await opened()
    const article = container.querySelector('article')!
    expect(article.getAttribute('data-chapter-id')).toBe('c1')
    expect(article.textContent).toBe('Hello world')
    expect(article.querySelector('script')).toBeNull()
  })

  it('engine_Mounted_IsTheChaptersEngine', async () => {
    const { rerender } = render(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One</p>" settings={settings} />)
    await opened()
    expect(mountedEngineFor('ch-1')?.engine.current()?.href).toBe('ch-1')
    rerender(<ReaderSection chapterId="c2" chapterSlug="ch-2" chapterIndex={1} html="<p>Two</p>" settings={settings} />)
    expect(mountedEngineFor('ch-1')).toBeNull()
    expect(mountedEngineFor('ch-2')).not.toBeNull()
    cleanup()
    expect(mountedEngineFor('ch-2')).toBeNull()
  })

  it('engine_OldChapterUnmountsAfterTheNew_NewStaysMounted', async () => {
    const old = render(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One</p>" settings={settings} />)
    render(<ReaderSection chapterId="c2" chapterSlug="ch-2" chapterIndex={1} html="<p>Two</p>" settings={settings} />)
    old.unmount()
    expect(mountedEngineFor('ch-2')).not.toBeNull()
  })

  it('engine_StrictModeDoubleMount_OnlyTheLiveEngineReportsOpened', async () => {
    const onEngineOpened = vi.fn()
    render(<StrictMode><ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One</p>" settings={settings} onEngineOpened={onEngineOpened} /></StrictMode>)
    await opened()
    expect(onEngineOpened).toHaveBeenCalledTimes(1)
    expect(onEngineOpened).toHaveBeenCalledWith('ch-1')
    expect(mountedEngineFor('ch-1')?.engine.current()?.href).toBe('ch-1')
  })

  it('engine_NewHtmlForTheSameChapter_ReopensWhereTheReaderIs', async () => {
    const { rerender } = render(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One</p>" settings={settings} />)
    await opened()
    const { engine } = mountedEngineFor('ch-1')!
    const here = engine.current()
    const open = vi.spyOn(engine, 'open')
    rerender(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One, refreshed</p>" settings={settings} />)
    expect(open.mock.calls[0][1]).toEqual(here)
  })

  // Rewrite of ReaderSection.test "keeps the chapter DOM across re-renders": a literal `{ __html }` rebuilt
  // the chapter on every render, killing every live Range. Now a new identity would reopen it in the engine.
  it('engine_ReRenderWithTheSameHtml_KeepsTheChapter', async () => {
    const { container, rerender } = render(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>Hello world</p>" settings={settings} />)
    await opened()
    const open = vi.spyOn(mountedEngineFor('ch-1')!.engine, 'open')
    const text = container.querySelector('p')!.firstChild
    rerender(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>Hello world</p>" settings={{ ...settings, fontSize: 22 }} />)
    await opened()
    expect(open).not.toHaveBeenCalled()
    expect(container.querySelector('p')!.firstChild).toBe(text)
  })

  it('engine_Typography_GoesToTheChapter', async () => {
    const { container, rerender } = render(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One</p>" settings={settings} />)
    await opened()
    rerender(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One</p>" settings={{ ...settings, fontSize: 24, textAlign: 'center' }} />)
    const article = container.querySelector('article')!
    expect(article.style.fontSize).toBe('24px')
    expect(article.style.textAlign).toBe('center')
  })

  it('engine_OpenFails_ReportsTheErrorAndTheChapter_849', async () => {
    const onEngineError = vi.fn()
    reportError.mockClear()
    const { rerender } = render(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One</p>" settings={settings} onEngineError={onEngineError} />)
    await opened()
    const boom = new Error('engine broke')
    vi.spyOn(mountedEngineFor('ch-1')!.engine, 'open').mockRejectedValue(boom)
    rerender(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One, refreshed</p>" settings={settings} onEngineError={onEngineError} />)
    await opened()
    expect(onEngineError).toHaveBeenCalledWith('ch-1')
    expect(reportError).toHaveBeenCalledWith(boom, { area: 'reader-engine', chapter: 'ch-1' })
  })

  it('engine_OpenReplacedByANewerOne_OnlyTheNewerReportsOpened_849', async () => {
    const onEngineOpened = vi.fn()
    const { rerender } = render(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One</p>" settings={settings} onEngineOpened={onEngineOpened} />)
    rerender(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One, refreshed</p>" settings={settings} onEngineOpened={onEngineOpened} />)
    await opened()
    expect(onEngineOpened).toHaveBeenCalledTimes(1)
  })

  it('engine_GoToOvertakesTheOpen_ChapterStillReportsOpened_E46', async () => {
    const onEngineOpened = vi.fn()
    render(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One</p>" settings={settings} onEngineOpened={onEngineOpened} />)
    // Before the open lands: the open resolves 'superseded', but its document is on screen.
    void mountedEngineFor('ch-1')!.engine.goTo({ href: 'ch-1', type: 'text/html', locations: { progression: 0 } })
    await opened()
    expect(onEngineOpened).toHaveBeenCalledWith('ch-1')
  })

  it('engine_OpenRejectsAfterAnUnmount_ReportsNothing_849', async () => {
    const onEngineError = vi.fn()
    reportError.mockClear()
    const { rerender, unmount } = render(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One</p>" settings={settings} onEngineError={onEngineError} />)
    await opened()
    vi.spyOn(mountedEngineFor('ch-1')!.engine, 'open').mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('destroyed')), 10)))
    rerender(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>One, refreshed</p>" settings={settings} onEngineError={onEngineError} />)
    unmount()
    await opened()
    expect(onEngineError).not.toHaveBeenCalled()
    expect(reportError).not.toHaveBeenCalled()
  })

  it('engine_TapOnText_ShowsTheBars_818', async () => {
    const onTap = vi.fn()
    const { container } = render(<ReaderSection chapterId="c1" chapterSlug="ch-1" chapterIndex={0} html="<p>Hello world</p>" settings={settings} onTap={onTap} />)
    await opened()
    fireEvent.click(container.querySelector('p')!)
    expect(onTap).toHaveBeenCalledTimes(1)
  })
})
