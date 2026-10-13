import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { buildTextPosition, serializeTextPosition } from '@textstack/shared'
import { locatorToPosition, type EngineEvents, type GoToResult, type Locator, type ReaderEngine } from '@textstack/reader-engine'
import { useReaderScrollSync } from '../useReaderScrollSync'
import { setMountedEngine, unmountEngine } from '../../lib/readerEngine'
import type { NewerPositionResult } from '../useReaderProgress'

// Phase 4 slice 1 (owner decision 4): with the engine on, useReaderScrollSync keeps its rules (ADR-019)
// but the engine positions the reader — restore and the newer-position move are `goTo`, the saved
// place is `current()`, and the engine's own moves (open, goTo, style, reflow) are never a save.

type Props = Parameters<typeof useReaderScrollSync>[0]

function setScroll(top: number) {
  const el = (document.scrollingElement || document.documentElement) as HTMLElement
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true })
}
function userScroll(top: number) {
  setScroll(top)
  window.dispatchEvent(new Event('scroll'))
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(16) })

const TEXT = 'It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith hurried.'
const positionAt = (slug: string, offset: number) =>
  serializeTextPosition(buildTextPosition({ chapterSlug: slug, chapterText: TEXT, charOffset: offset, chapterFraction: 0.3 })!)

const mountedFakes: ReaderEngine[] = []

/** An engine that lands every move at `landAt` and says it is at `here`. */
function fakeEngine(href: string) {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const state = { here: null as Locator | null, landAt: 0 }
  const engine = {
    goTo: vi.fn(async (at: Locator) => {
      setScroll(state.landAt)
      state.here = at
      emit('relocated', { locator: at, reason: 'goTo' })
      return 'exact' as GoToResult
    }),
    current: () => state.here,
    on: (e: string, cb: (p: unknown) => void) => {
      if (!listeners.has(e)) listeners.set(e, new Set())
      listeners.get(e)!.add(cb)
      return () => { listeners.get(e)!.delete(cb) }
    },
  }
  function emit<K extends keyof EngineEvents>(e: K, p: EngineEvents[K]) {
    listeners.get(e)?.forEach((cb) => cb(p))
  }
  setMountedEngine({ engine: engine as unknown as ReaderEngine, href })
  mountedFakes.push(engine as unknown as ReaderEngine)
  return { engine, state, emit }
}

const updateProgress = vi.fn()
const baseProps = (): Props => ({
  mode: 'public',
  chapterIdentifier: 'ch1',
  chapterLoaded: true,
  originalActive: false,
  overallProgress: 0,
  effectiveProgress: null,
  effectiveLoading: false,
  publicBookChapters: [{ id: 'ch1-id', slug: 'ch1' }] as Props['publicBookChapters'],
  publicProgress: { updateProgress, flushSave: vi.fn() },
  userProgress: { saveProgress: vi.fn(), flushSave: vi.fn() },
  settingsKey: '18 1.8 serif left',
})

beforeEach(() => {
  vi.useFakeTimers()
  updateProgress.mockClear()
  setScroll(0)
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
})
afterEach(() => {
  mountedFakes.splice(0).forEach(unmountEngine)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useReaderScrollSync with the engine — restore', () => {
  it('restore_SavedTextPosition_EngineGoesToIt', async () => {
    const { engine } = fakeEngine('ch1')
    const json = positionAt('ch1', 35)
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { positionJson: json, locator: 'scroll:ch1:900' } }))
    await settle()
    const at = engine.goTo.mock.calls[0][0]
    expect(at.href).toBe('ch1')
    expect(at.text?.highlight).toBe(TEXT.slice(35, 35 + (at.text?.highlight?.length ?? 0)))
    expect(at.locations.legacyScrollY).toBe(900)   // the ladder's last rung before the top
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('restore_OnlyLegacyScrollLocator_EngineGoesToTheOffset', async () => {
    const { engine } = fakeEngine('ch1')
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:500' } }))
    await settle()
    expect(engine.goTo.mock.calls[0][0]).toEqual({ href: 'ch1', type: 'text/html', locations: { legacyScrollY: 500 } })
  })

  it('restore_NothingSaved_EngineGoesToTop', async () => {
    const { engine } = fakeEngine('ch1')
    renderHook(() => useReaderScrollSync(baseProps()))
    await settle()
    expect(engine.goTo.mock.calls[0][0]).toEqual({ href: 'ch1', type: 'text/html', locations: { progression: 0 } })
  })

  it('restore_AnotherChaptersPosition_NotUsed', async () => {
    const { engine } = fakeEngine('ch2')
    renderHook(() => useReaderScrollSync({ ...baseProps(), chapterIdentifier: 'ch2', publicBookChapters: [{ id: 'ch2-id', slug: 'ch2' }] as Props['publicBookChapters'], effectiveProgress: { positionJson: positionAt('ch1', 35) } }))
    await settle()
    expect(engine.goTo.mock.calls[0][0]).toEqual({ href: 'ch2', type: 'text/html', locations: { progression: 0 } })
  })
})

describe('useReaderScrollSync with the engine — save', () => {
  it('save_OnOpen_WritesTheEnginesPlace', async () => {
    const { state } = fakeEngine('ch1')
    const json = positionAt('ch1', 35)
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { positionJson: json } }))
    await settle()
    expect(updateProgress).toHaveBeenCalledTimes(1)
    expect(updateProgress.mock.calls[0][5]).toBe(locatorToPosition(state.here))
  })

  it('save_ReaderScroll_WritesTheEnginesCurrentPlace', async () => {
    const { state } = fakeEngine('ch1')
    renderHook(() => useReaderScrollSync(baseProps()))
    await settle()
    updateProgress.mockClear()
    const moved = positionAt('ch1', 50)
    state.here = { href: 'ch1', type: 'text/html', locations: { progression: 0.4, charOffset: 50 }, text: { highlight: TEXT.slice(50, 60) } }
    userScroll(800)
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(updateProgress).toHaveBeenCalledTimes(1)
    expect(updateProgress.mock.calls[0][2]).toBe('scroll:ch1:800')
    expect(JSON.parse(updateProgress.mock.calls[0][5]).charOffset).toBe(JSON.parse(moved!).charOffset)
  })

  it('save_EnginesOwnMove_IsNotTheReaders', async () => {
    const { emit, state } = fakeEngine('ch1')
    const onReaderScroll = vi.fn()
    renderHook(() => useReaderScrollSync({ ...baseProps(), onReaderScroll }))
    await settle()
    updateProgress.mockClear()
    // A style change: the engine re-anchors (scrollTop moves), says so, then the browser's scroll arrives.
    setScroll(1200)
    emit('relocated', { locator: state.here!, reason: 'style' })
    window.dispatchEvent(new Event('scroll'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(updateProgress).not.toHaveBeenCalled()
    expect(onReaderScroll).not.toHaveBeenCalled()
  })

  it('settingsChange_EngineOn_HookDoesNotScroll', async () => {
    fakeEngine('ch1')
    const { rerender, result } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: baseProps() })
    await settle()
    result.current.captureBeforeReflow()
    rerender({ ...baseProps(), settingsKey: '24 1.8 serif left' })
    await settle()
    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})

describe('useReaderScrollSync with the engine — review fixes', () => {
  it('restore_SupersededByANewerRestore_OnlyTheNewerOneLands', async () => {
    const { engine } = fakeEngine('ch1')
    engine.goTo.mockImplementationOnce(async () => 'superseded' as GoToResult)
    renderHook(() => useReaderScrollSync(baseProps()))
    await settle()
    // The superseded goTo did not mark the chapter restored: no save-on-open from a mid-move place.
    expect(updateProgress).not.toHaveBeenCalled()
  })

  it('engineMove_AfterAHighlightLinkPositioned_IsNotTheReaders', async () => {
    const { emit, state } = fakeEngine('ch1')
    state.here = { href: 'ch1', type: 'text/html', locations: { progression: 0.5, charOffset: 50 }, text: { highlight: TEXT.slice(50, 60) } }
    const onReaderScroll = vi.fn()
    const { result } = renderHook(() => useReaderScrollSync({ ...baseProps(), holdRestore: true, onReaderScroll }))
    act(() => result.current.markPositioned())
    await settle()
    updateProgress.mockClear()
    setScroll(1200)
    emit('relocated', { locator: state.here!, reason: 'style' })
    window.dispatchEvent(new Event('scroll'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(updateProgress).not.toHaveBeenCalled()
    expect(onReaderScroll).not.toHaveBeenCalled()
  })

  it('reflow_AfterTheReaderMoved_TheirMoveStillCounts', async () => {
    const { engine, emit, state } = fakeEngine('ch1')
    let answer!: (r: NewerPositionResult) => void
    const fetchNewerPosition = vi.fn(() => new Promise<NewerPositionResult>((r) => { answer = r }))
    renderHook(() => useReaderScrollSync({ ...baseProps(), serverUnanswered: true, fetchNewerPosition }))
    await settle()
    await settle()
    expect(fetchNewerPosition).toHaveBeenCalledTimes(1)
    userScroll(800)                                          // the reader reads on…
    setScroll(830)                                           // …an image loads above, the engine re-anchors
    emit('relocated', { locator: state.here!, reason: 'reflow' })
    await act(async () => { answer({ chapterSlug: 'ch1', locator: null, positionJson: positionAt('ch1', 60) }) })
    await settle()
    // Another device's place does not replace where the reader moved to.
    expect(engine.goTo).toHaveBeenCalledTimes(1)
  })

  it('newerPosition_TopOfTheChapter_EngineGoesThere', async () => {
    const { engine } = fakeEngine('ch1')
    const fetchNewerPosition = vi.fn(async (): Promise<NewerPositionResult> => ({ chapterSlug: 'ch1', locator: 'scroll:ch1:0', positionJson: null }))
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:500' }, serverUnanswered: true, fetchNewerPosition }))
    await settle()
    await settle()
    expect(engine.goTo).toHaveBeenCalledTimes(2)
    expect(engine.goTo.mock.calls[1][0]).toEqual({ href: 'ch1', type: 'text/html', locations: { progression: 0 } })
  })
})
