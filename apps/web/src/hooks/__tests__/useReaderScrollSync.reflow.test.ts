import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// H2: a typography change reflows the article. The reading-line anchor must be
// taken from the layout BEFORE the change; reading it after reflow records
// whatever text now sits on the line, i.e. a different place.

const TEXT = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} of the chapter. `).join('')
const layout = { lineOffset: 4000 } // char offset under the reading line in the current layout

vi.mock('../../lib/textAnchor', () => ({
  readReadingLine: () => (layout.lineOffset < 0 ? null : { chapterText: TEXT, charOffset: layout.lineOffset }),
  articleText: () => TEXT,
  rangeAtCharOffset: vi.fn((_a: HTMLElement, offset: number) => ({
    getBoundingClientRect: () => ({ top: offset }),
  })),
}))

import { rangeAtCharOffset } from '../../lib/textAnchor'
import { useReaderScrollSync } from '../useReaderScrollSync'

class RO {
  constructor(private cb: () => void) {}
  observe() { this.cb() }
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
  vi.stubGlobal('ResizeObserver', RO)
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  const art = document.createElement('article')
  art.className = 'reader-section__article'
  document.body.appendChild(art)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const props = {
  mode: 'public' as const,
  chapterIdentifier: 'ch1',
  chapterLoaded: true,
  originalActive: false,
  overallProgress: 0,
  effectiveProgress: null,
  effectiveLoading: false,
  publicBookChapters: [{ id: 'ch1-id', slug: 'ch1' }] as never,
  publicProgress: { updateProgress: vi.fn(), flushSave: vi.fn() },
  userProgress: { saveProgress: vi.fn(), flushSave: vi.fn() },
  settingsKey: '18 1.6 serif left',
}

describe('useReaderScrollSync — reflow keeps the reading line', () => {
  it('re-anchors to the text that was on the line BEFORE the font change', () => {
    const { result, rerender } = renderHook((p: typeof props) => useReaderScrollSync(p), { initialProps: props })

    layout.lineOffset = 4000
    act(() => result.current.captureBeforeReflow())
    // A+ applied: the same scrollTop now shows earlier text on the line.
    layout.lineOffset = 2500
    vi.mocked(rangeAtCharOffset).mockClear()
    rerender({ ...props, settingsKey: '22 1.6 serif left' })

    const offsets = vi.mocked(rangeAtCharOffset).mock.calls.map((c) => c[1])
    expect(offsets.length).toBeGreaterThan(0)
    expect(offsets.every((o) => o === 4000)).toBe(true)
  })

  it('falls back to the last scroll-pause line when the drawer covers the reading line', () => {
    vi.useFakeTimers()
    try {
      const { result, rerender } = renderHook((p: typeof props) => useReaderScrollSync(p), { initialProps: props })
      layout.lineOffset = 3000
      act(() => { window.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(200) })
      // Drawer open: hit-testing the reading line finds the drawer, not text.
      layout.lineOffset = -1
      act(() => result.current.captureBeforeReflow())
      layout.lineOffset = 2500
      vi.mocked(rangeAtCharOffset).mockClear()
      rerender({ ...props, settingsKey: '22 1.6 serif left' })
      const offsets = vi.mocked(rangeAtCharOffset).mock.calls.map((c) => c[1])
      expect(offsets.length).toBeGreaterThan(0)
      expect(offsets.every((o) => o === 3000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
