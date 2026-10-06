import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEffect, useState } from 'react'

// Web reader R4: a hanging or failed progress GET, a late or newer answer from the server, saves
// scoped to the document they were made in, and the restore's own scroll never being a save.
//
// `window.scrollTo` here behaves like the browser's: it moves the page at once and fires a
// `scroll` event a frame later — the echo that the first R4 version saved as if the reader made it.

const readProgress = vi.fn()
vi.mock('../../api/auth', () => ({ readProgress: (...a: unknown[]) => readProgress(...a) }))
const auth = { isAuthenticated: true, isLoading: false }
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../../api/readingTracking', () => ({ submitSession: vi.fn(async () => ({})) }))
vi.mock('../../lib/analytics', () => ({ trackReadingSessionEnd: vi.fn() }))

import { useReaderScrollSync } from '../useReaderScrollSync'
import { useRestoreProgress } from '../useRestoreProgress'
import { useReadingSession } from '../useReadingSession'
import type { NewerPositionResult } from '../useReaderProgress'

type Props = Parameters<typeof useReaderScrollSync>[0]

const PAGE_MAX = 20_000
function setScroll(top: number) {
  const el = (document.scrollingElement || document.documentElement) as HTMLElement
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true })
}
function getScroll() {
  return ((document.scrollingElement || document.documentElement) as HTMLElement).scrollTop
}
/** The reader scrolls: input (a wheel turn), then the scroll it causes. */
function userScroll(top: number) {
  window.dispatchEvent(new Event('wheel'))
  setScroll(top)
  window.dispatchEvent(new Event('scroll'))
}
/** The browser scrolls on its own (scroll anchoring as an image loads above): no input. */
function browserScroll(top: number) {
  setScroll(top)
  window.dispatchEvent(new Event('scroll'))
}
function setVisibility(v: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}
/** Let pending promises and the scroll echo (a 16 ms "frame") run. */
const frame = () => act(async () => { await vi.advanceTimersByTimeAsync(16) })

const updateProgress = vi.fn()
const baseProps = (): Props => ({
  mode: 'public',
  chapterIdentifier: 'ch1',
  chapterLoaded: true,
  originalActive: false,
  overallProgress: 0,
  effectiveProgress: null,
  effectiveLoading: false,
  publicBookChapters: [{ id: 'ch1-id', slug: 'ch1' }, { id: 'ch2-id', slug: 'ch2' }] as never,
  publicProgress: { updateProgress, flushSave: vi.fn() },
  userProgress: { saveProgress: vi.fn(), flushSave: vi.fn() },
  settingsKey: 'k',
})
const locators = () => updateProgress.mock.calls.map((c) => c[2] as string)
const newer = (locator: string, chapterSlug = 'ch1'): NewerPositionResult => ({ chapterSlug, locator, positionJson: null })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
  window.scrollTo = vi.fn((arg: unknown) => {
    const before = getScroll()
    const top = Math.max(0, Math.min(PAGE_MAX, (arg as { top: number }).top))
    setScroll(top)
    if (top !== before) setTimeout(() => window.dispatchEvent(new Event('scroll')), 16)
  }) as never
  updateProgress.mockReset()
  readProgress.mockReset()
  auth.isAuthenticated = true
  auth.isLoading = false
  localStorage.clear()
  setScroll(0)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

describe('R4-2 + review #1: an unanswered GET restores locally and never stamps the restored place', () => {
  // The real wrapper resolves undefined when its signal aborts.
  const hangUntilAborted = (_id: string, signal?: AbortSignal) =>
    new Promise((resolve) => signal?.addEventListener('abort', () => resolve(undefined)))

  function mountRestoreAndSync(extra: Partial<Props> = {}) {
    return renderHook(() => {
      const r = useRestoreProgress('e1', 'ch1')
      return useReaderScrollSync({
        ...baseProps(),
        effectiveProgress: r.savedProgress,
        effectiveLoading: r.isLoading,
        serverUnanswered: r.serverUnanswered,
        ...extra,
      })
    })
  }
  const seedLocal = (offset: number) => localStorage.setItem('reading.progress.e1', JSON.stringify({
    chapterSlug: 'ch1', locator: `scroll:ch1:${offset}`, updatedAt: Date.now(), synced: true,
  }))

  it('a hanging GET: after 3 s it restores from this device; the echo is not saved; the reader\'s scroll is', async () => {
    seedLocal(2000)
    readProgress.mockImplementation(hangUntilAborted)
    mountRestoreAndSync()
    expect(window.scrollTo).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'instant' })
    // The echo of that scrollTo, then well past the 1.5 s save debounce.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(locators()).toEqual([])

    act(() => { userScroll(2600) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(locators()).toEqual(['scroll:ch1:2600'])
  })

  it('a FAST failure (5xx, offline, 401) is treated like the timeout (review #3)', async () => {
    seedLocal(2000)
    readProgress.mockResolvedValue(undefined)
    const { result } = renderHook(() => useRestoreProgress('e1', 'ch1'))
    await frame()
    expect(result.current.isLoading).toBe(false)
    expect(result.current.serverUnanswered).toBe(true)
  })

  it('auth that never settles does not hold the restore either', async () => {
    auth.isLoading = true
    seedLocal(900)
    mountRestoreAndSync()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'instant' })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(locators()).toEqual([])
    act(() => { userScroll(1300) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(locators()).toEqual(['scroll:ch1:1300'])
  })

  it('an answered open still records its position (save-on-open), and the echo adds nothing', async () => {
    seedLocal(2000)
    readProgress.mockResolvedValue(null)
    mountRestoreAndSync()
    await frame()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(locators()).toEqual(['scroll:ch1:2000'])
  })
})

describe('the background re-ask after an unanswered open', () => {
  it('the reader has not moved → goes to the newer place, and does not save the server\'s own position back', async () => {
    const fetchNewerPosition = vi.fn(async () => newer('scroll:ch1:7000'))
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, serverUnanswered: true, fetchNewerPosition }))
    await frame()
    expect(fetchNewerPosition).toHaveBeenCalledTimes(1)
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 7000, behavior: 'instant' })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(locators()).toEqual([])
  })

  it('the reader has moved → never yanked', async () => {
    let answer!: (r: NewerPositionResult) => void
    const fetchNewerPosition = vi.fn(() => new Promise<NewerPositionResult>((r) => { answer = r }))
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, serverUnanswered: true, fetchNewerPosition }))
    await frame()
    act(() => { userScroll(4000) })
    await act(async () => { answer(newer('scroll:ch1:7000')) })
    expect(window.scrollTo).not.toHaveBeenCalledWith({ top: 7000, behavior: 'instant' })
  })

  it('review #3: a failed re-ask is retried on a backoff and when the browser comes online', async () => {
    const fetchNewerPosition = vi.fn(async (): Promise<NewerPositionResult> => null)
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, serverUnanswered: true, fetchNewerPosition }))
    await frame()
    expect(fetchNewerPosition).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(fetchNewerPosition).toHaveBeenCalledTimes(2)

    fetchNewerPosition.mockImplementation(async () => newer('scroll:ch1:7000'))
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await frame()
    expect(fetchNewerPosition).toHaveBeenCalledTimes(3)
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 7000, behavior: 'instant' })

    // Answered: the remaining backoff does not ask again.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetchNewerPosition).toHaveBeenCalledTimes(3)
  })
})

describe('R4-4: a tab coming back re-checks the server', () => {
  it('newer elsewhere and the reader has not moved → moves there; the stale place is not written', async () => {
    const fetchNewerPosition = vi.fn(async (): Promise<NewerPositionResult> => false)
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, fetchNewerPosition }))
    await frame()
    act(() => { userScroll(2500) })
    act(() => { setVisibility('hidden') }) // flushes 2500
    expect(locators()[locators().length - 1]).toBe('scroll:ch1:2500')
    const writesBefore = updateProgress.mock.calls.length

    fetchNewerPosition.mockImplementation(async () => newer('scroll:ch1:9000')) // the phone read on
    await act(async () => { setVisibility('visible') })
    await frame()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 9000, behavior: 'instant' })
    expect(locators().slice(writesBefore)).toEqual([])
  })

  it('the reader moved while the check was in flight → stays put', async () => {
    let answer!: (r: NewerPositionResult) => void
    const fetchNewerPosition = vi.fn(() => new Promise<NewerPositionResult>((r) => { answer = r }))
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, fetchNewerPosition }))
    await frame()
    await act(async () => { setVisibility('visible') })
    act(() => { userScroll(4000) })
    await act(async () => { answer(newer('scroll:ch1:9000')) })
    expect(window.scrollTo).not.toHaveBeenCalledWith({ top: 9000, behavior: 'instant' })
  })

  it('newer in another chapter → web neither navigates nor scrolls', async () => {
    const fetchNewerPosition = vi.fn(async () => newer('scroll:ch2:9000', 'ch2'))
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, fetchNewerPosition }))
    await frame()
    ;(window.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    await act(async () => { setVisibility('visible') })
    await frame()
    expect(fetchNewerPosition).toHaveBeenCalled()
    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})

describe('review #5: an explicit position beats a newer one', () => {
  it('a ?highlight= jump (markPositioned) is not pulled away', async () => {
    const fetchNewerPosition = vi.fn(async () => newer('scroll:ch1:9000'))
    const { result } = renderHook(() => useReaderScrollSync({ ...baseProps(), holdRestore: true, fetchNewerPosition }))
    act(() => { window.scrollTo({ top: 3300, behavior: 'instant' }) }) // the highlight link lands
    act(() => { result.current.markPositioned() })
    await frame()
    await act(async () => { setVisibility('visible') })
    await frame()
    expect(fetchNewerPosition).toHaveBeenCalled()
    expect(getScroll()).toBe(3300)
  })

  it('a ?direct=1 open is not pulled away, and its chapter-top save is kept even unanswered', async () => {
    const fetchNewerPosition = vi.fn(async () => newer('scroll:ch1:9000'))
    renderHook(() => useReaderScrollSync({ ...baseProps(), explicitOpen: true, serverUnanswered: true, fetchNewerPosition }))
    await frame()
    await act(async () => { setVisibility('visible') })
    await frame()
    expect(fetchNewerPosition).toHaveBeenCalled()
    expect(getScroll()).toBe(0)
    expect(locators()).toEqual(['scroll:ch1:0'])
  })

  it('once the reader scrolls on from the explicit place, a later newer position applies again', async () => {
    const fetchNewerPosition = vi.fn(async (): Promise<NewerPositionResult> => false)
    renderHook(() => useReaderScrollSync({ ...baseProps(), explicitOpen: true, fetchNewerPosition }))
    await frame()
    act(() => { userScroll(1200) })
    act(() => { setVisibility('hidden') })
    fetchNewerPosition.mockImplementation(async () => newer('scroll:ch1:9000'))
    await act(async () => { setVisibility('visible') })
    await frame()
    expect(getScroll()).toBe(9000)
  })
})

describe('review #6: a check in flight dies with its chapter', () => {
  it('chapter change: the fetch is aborted and its late answer does not scroll the new chapter', async () => {
    let answer!: (r: NewerPositionResult) => void
    let seen: AbortSignal | undefined
    const fetchNewerPosition = vi.fn((signal: AbortSignal) => { seen = signal; return new Promise<NewerPositionResult>((r) => { answer = r }) })
    const props = { ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, fetchNewerPosition }
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: props })
    await frame()
    await act(async () => { setVisibility('visible') })
    rerender({ ...props, chapterIdentifier: 'ch2' })
    await frame()
    expect(seen?.aborted).toBe(true)
    ;(window.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    await act(async () => { answer(newer('scroll:ch1:9000')) })
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('unmount: the fetch is aborted', async () => {
    let seen: AbortSignal | undefined
    const fetchNewerPosition = vi.fn((signal: AbortSignal) => { seen = signal; return new Promise<NewerPositionResult>(() => {}) })
    const { unmount } = renderHook(() => useReaderScrollSync({ ...baseProps(), fetchNewerPosition }))
    await frame()
    await act(async () => { setVisibility('visible') })
    unmount()
    expect(seen?.aborted).toBe(true)
  })
})

describe('review #7: the restore is not reading', () => {
  it('wordsRead counts from the restored place, not from the chapter top', async () => {
    Object.defineProperty(navigator, 'sendBeacon', { value: vi.fn(() => true), configurable: true })
    // Book of 1000 words; this chapter is the whole book, so percent = scroll / PAGE_MAX.
    const { unmount } = renderHook(() => {
      const session = useReadingSession({ editionId: 'e1', totalWords: 1000, startPercent: 0, isAuthenticated: true })
      // ReaderPage: progress is state set by its own scroll listener, so it reaches the session
      // one render AFTER the scroll event that moved it.
      const [percent, setPercent] = useState(0)
      useEffect(() => {
        const read = () => setPercent(getScroll() / PAGE_MAX)
        window.addEventListener('scroll', read)
        return () => window.removeEventListener('scroll', read)
      }, [])
      useEffect(() => { session.updatePercent(percent) }, [percent, session])
      useReaderScrollSync({
        ...baseProps(),
        effectiveProgress: { locator: 'scroll:ch1:10000' },
        onReaderScroll: session.recordActivity,
      })
      return session
    })
    await frame() // restore to 50% and its echo
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    act(() => { userScroll(12_000) }) // the reader reads 10% of the book
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    act(() => { userScroll(12_010) })
    unmount()
    const sent = JSON.parse(localStorage.getItem('reading.pendingSessions') || '[]')
    expect(sent).toHaveLength(1)
    expect(sent[0].startPercent).toBeCloseTo(0.5)
    expect(sent[0].wordsRead).toBe(101)
  })
})

describe('ADR-019: saves are scoped to their document', () => {
  it('Next within the 1.5 s debounce: the pending save goes to the chapter being left', async () => {
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: baseProps() })
    await frame()
    act(() => { userScroll(3100) })
    act(() => { vi.advanceTimersByTime(500) })
    rerender({ ...baseProps(), chapterIdentifier: 'ch2', chapterLoaded: false })
    expect(locators()).toContain('scroll:ch1:3100')
    expect(locators().filter((l) => l.startsWith('scroll:ch2:'))).toEqual([])
  })

  it('reflow → PDF layout within the debounce: the pending reflow save is dropped', async () => {
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: baseProps() })
    await frame()
    const before = locators().length
    act(() => { userScroll(3100) })
    rerender({ ...baseProps(), originalActive: true })
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { setVisibility('hidden') })
    expect(locators().slice(before)).toEqual([])
  })
})

describe("round 2 #1: only the reader's own scrolls count", () => {
  it('a browser-driven scroll (no input) is not saved, is not "moving", and is not reading', async () => {
    const onReaderScroll = vi.fn()
    let answer!: (r: NewerPositionResult) => void
    const fetchNewerPosition = vi.fn(() => new Promise<NewerPositionResult>((r) => { answer = r }))
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, fetchNewerPosition, onReaderScroll }))
    await frame()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) }) // past the echo and input windows
    const before = locators().length
    await act(async () => { setVisibility('visible') })
    act(() => { browserScroll(2350) }) // an image above finished loading
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await act(async () => { answer(newer('scroll:ch1:9000')) }) // not "moved": the newer place applies
    expect(getScroll()).toBe(9000)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(locators().slice(before)).toEqual([])
    expect(onReaderScroll).not.toHaveBeenCalled()
  })

  it("momentum after the last touch is still the reader's", async () => {
    renderHook(() => useReaderScrollSync(baseProps()))
    await frame()
    act(() => { window.dispatchEvent(new Event('touchmove')) })
    act(() => { vi.advanceTimersByTime(900); browserScroll(1000) })
    for (let i = 1; i <= 10; i++) act(() => { vi.advanceTimersByTime(100); browserScroll(1000 + i * 50) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(locators()[locators().length - 1]).toBe('scroll:ch1:1500')
  })
})

describe('round 2 #5: only THE open is held back', () => {
  it('after an unanswered open, a chapter the reader goes to is saved on open', async () => {
    const props = { ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, serverUnanswered: true }
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: props })
    await frame()
    expect(locators()).toEqual([])
    rerender({ ...props, chapterIdentifier: 'ch2', chapterLoaded: false })
    rerender({ ...props, chapterIdentifier: 'ch2' })
    await frame()
    expect(locators()).toEqual(['scroll:ch2:0'])
  })
})

describe('round 2 #4: one check at a time, and tab flicking is throttled', () => {
  it('visible does not abort a slower check in flight', async () => {
    let seen: AbortSignal | undefined
    const fetchNewerPosition = vi.fn((signal: AbortSignal) => { seen = signal; return new Promise<NewerPositionResult>(() => {}) })
    renderHook(() => useReaderScrollSync({ ...baseProps(), serverUnanswered: true, fetchNewerPosition }))
    await frame()
    expect(fetchNewerPosition).toHaveBeenCalledTimes(1)
    await act(async () => { setVisibility('visible') })
    expect(seen?.aborted).toBe(false)
    expect(fetchNewerPosition).toHaveBeenCalledTimes(1)
  })

  it('at most one visible re-check per 30 s', async () => {
    const fetchNewerPosition = vi.fn(async (): Promise<NewerPositionResult> => false)
    renderHook(() => useReaderScrollSync({ ...baseProps(), fetchNewerPosition }))
    await frame()
    for (let i = 0; i < 5; i++) {
      await act(async () => { setVisibility('hidden'); setVisibility('visible') })
      await frame()
    }
    expect(fetchNewerPosition).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await act(async () => { setVisibility('visible') })
    expect(fetchNewerPosition).toHaveBeenCalledTimes(2)
  })
})
