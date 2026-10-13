import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

// Phase 4 review fix: with the engine on, the chapter is ready only once the engine's open has landed,
// so restore, a `?highlight=` jump and save-on-open never race the open's landing at the top.
vi.mock('../../lib/readerEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/readerEngine')>()),
  READER_ENGINE: true,
}))
const scrollSync = vi.fn((_p: { chapterLoaded: boolean }) => ({ flushSave: vi.fn(), captureBeforeReflow: vi.fn(), markPositioned: vi.fn() }))
vi.mock('../useReaderScrollSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../useReaderScrollSync')>()),
  useReaderScrollSync: (p: { chapterLoaded: boolean }) => scrollSync(p),
}))

import { useReaderPositionSync } from '../useReaderPositionSync'

type Params = Parameters<typeof useReaderPositionSync>[0]

const params = (engineOpenedFor: string | null) => ({
  mode: 'public',
  publicBook: null,
  chapter: { identifier: 'ch1' },
  chapterIdentifier: 'ch1',
  loading: false,
  originalActive: false,
  overallProgress: 0,
  progress: { serverUnanswered: false },
  settings: { fontSize: 18, lineHeight: 1.8, fontFamily: 'serif', textAlign: 'left' },
  engineOpenedFor,
  scrollToHighlightId: 'h1',
  highlightsLoaded: true,
  authLoading: false,
  onReaderScroll: vi.fn(),
  location: { pathname: '/', search: '', hash: '', state: null, key: '' },
  navigate: vi.fn(),
}) as unknown as Params

describe('useReaderPositionSync with the engine', () => {
  it('chapterReady_EngineOpenNotLanded_NotReady', () => {
    const { result } = renderHook(() => useReaderPositionSync(params(null)))
    expect(scrollSync.mock.lastCall![0].chapterLoaded).toBe(false)
    expect(result.current.highlightLinkReady).toBe(false)
  })

  it('chapterReady_EngineOpenedAnotherChapter_NotReady', () => {
    const { result } = renderHook(() => useReaderPositionSync(params('ch0')))
    expect(scrollSync.mock.lastCall![0].chapterLoaded).toBe(false)
    expect(result.current.highlightLinkReady).toBe(false)
  })

  it('chapterReady_EngineOpenLandedForThisChapter_Ready', () => {
    const { result } = renderHook(() => useReaderPositionSync(params('ch1')))
    expect(scrollSync.mock.lastCall![0].chapterLoaded).toBe(true)
    expect(result.current.highlightLinkReady).toBe(true)
  })
})
