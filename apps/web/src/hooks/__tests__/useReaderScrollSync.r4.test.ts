import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Web reader R4: a hanging progress GET, a late or newer answer from the server, and saves
// scoped to the document they were made in.

const getProgress = vi.fn()
vi.mock('../../api/auth', () => ({ getProgress: (...a: unknown[]) => getProgress(...a) }))
const auth = { isAuthenticated: true, isLoading: false }
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth }))

import { useReaderScrollSync } from '../useReaderScrollSync'
import { useRestoreProgress } from '../useRestoreProgress'
import type { NewerPositionResult } from '../useReaderProgress'

type Props = Parameters<typeof useReaderScrollSync>[0]

function setScroll(top: number) {
  const el = (document.scrollingElement || document.documentElement) as HTMLElement
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true })
}
function scrollBy(top: number) {
  setScroll(top)
  window.dispatchEvent(new Event('scroll'))
}
function setVisibility(v: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
  // AbortSignal.timeout runs on Node's own timers; drive it from the faked ones.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const c = new AbortController()
    setTimeout(() => c.abort(new DOMException('timeout', 'TimeoutError')), ms)
    return c.signal
  })
  window.scrollTo = vi.fn((arg: unknown) => setScroll((arg as { top: number }).top)) as never
  updateProgress.mockReset()
  getProgress.mockReset()
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

describe('R4-2: the progress GET is bounded', () => {
  // The wrapper in api/auth.ts resolves null on any failure, an abort included.
  const hangUntilAborted = (_id: string, init?: { signal?: AbortSignal }) =>
    new Promise((resolve) => init?.signal?.addEventListener('abort', () => resolve(null)))

  function mountRestoreAndSync() {
    return renderHook(() => {
      const r = useRestoreProgress('e1', 'ch1')
      return useReaderScrollSync({
        ...baseProps(),
        effectiveProgress: r.savedProgress,
        effectiveLoading: r.isLoading,
        serverTimedOut: r.serverTimedOut,
      })
    })
  }

  it('a hanging GET: after 3 s the reader restores from this device and saves', async () => {
    localStorage.setItem('reading.progress.e1', JSON.stringify({ chapterSlug: 'ch1', locator: 'scroll:ch1:2000', updatedAt: Date.now(), synced: true }))
    getProgress.mockImplementation(hangUntilAborted)
    mountRestoreAndSync()
    expect(window.scrollTo).not.toHaveBeenCalled()

    await act(async () => { vi.advanceTimersByTime(3000) })
    await settle()
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'instant' })
    // The local place is not stamped as the newest write while the server is unknown...
    expect(updateProgress).not.toHaveBeenCalled()

    // ...but the reader's own scroll is saved.
    act(() => { scrollBy(2600) })
    act(() => { vi.advanceTimersByTime(1500) })
    expect(locators()).toEqual(['scroll:ch1:2600'])
  })

  it('auth that never settles does not hold the restore either', async () => {
    auth.isLoading = true
    localStorage.setItem('reading.progress.e1', JSON.stringify({ chapterSlug: 'ch1', locator: 'scroll:ch1:900', updatedAt: Date.now() }))
    mountRestoreAndSync()
    await act(async () => { vi.advanceTimersByTime(3000) })
    await settle()
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'instant' })
    act(() => { scrollBy(1300) })
    act(() => { vi.advanceTimersByTime(1500) })
    expect(locators()).toEqual(['scroll:ch1:1300'])
  })
})

describe('R4-2: the late answer after a timed-out restore', () => {
  const newer = (locator: string, chapterSlug = 'ch1'): NewerPositionResult => ({ chapterSlug, locator, positionJson: null })

  it('the reader has not moved → goes to the newer place', async () => {
    const fetchNewerPosition = vi.fn(async () => newer('scroll:ch1:7000'))
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, serverTimedOut: true, fetchNewerPosition }))
    await settle()
    expect(fetchNewerPosition).toHaveBeenCalledTimes(1)
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 7000, behavior: 'instant' })
  })

  it('the reader has moved → never yanked', async () => {
    let answer!: (r: NewerPositionResult) => void
    const fetchNewerPosition = vi.fn(() => new Promise<NewerPositionResult>((r) => { answer = r }))
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, serverTimedOut: true, fetchNewerPosition }))
    act(() => { scrollBy(4000) })
    await act(async () => { answer(newer('scroll:ch1:7000')) })
    expect(window.scrollTo).not.toHaveBeenCalledWith({ top: 7000, behavior: 'instant' })
  })
})

describe('R4-4: a tab coming back re-checks the server', () => {
  const newer = (locator: string, chapterSlug = 'ch1'): NewerPositionResult => ({ chapterSlug, locator, positionJson: null })

  it('newer elsewhere and the reader has not moved → moves there; the stale place is not written', async () => {
    const fetchNewerPosition = vi.fn(async (): Promise<NewerPositionResult> => false)
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, fetchNewerPosition }))
    act(() => { scrollBy(2500) })
    act(() => { setVisibility('hidden') }) // flushes 2500
    expect(locators()[locators().length - 1]).toBe('scroll:ch1:2500')
    const writesBefore = updateProgress.mock.calls.length

    fetchNewerPosition.mockImplementation(async () => newer('scroll:ch1:9000')) // the phone read on
    await act(async () => { setVisibility('visible') })
    await settle()
    expect(fetchNewerPosition).toHaveBeenCalledWith(3000)
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 9000, behavior: 'instant' })
    expect(locators().slice(writesBefore)).not.toContain('scroll:ch1:2500')
  })

  it('the reader moved while the check was in flight → stays put', async () => {
    let answer!: (r: NewerPositionResult) => void
    const fetchNewerPosition = vi.fn(() => new Promise<NewerPositionResult>((r) => { answer = r }))
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, fetchNewerPosition }))
    await act(async () => { setVisibility('visible') })
    act(() => { scrollBy(4000) })
    await act(async () => { answer(newer('scroll:ch1:9000')) })
    expect(window.scrollTo).not.toHaveBeenCalledWith({ top: 9000, behavior: 'instant' })
  })

  it('newer in another chapter → web neither navigates nor scrolls', async () => {
    const fetchNewerPosition = vi.fn(async () => newer('scroll:ch2:9000', 'ch2'))
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, fetchNewerPosition }))
    ;(window.scrollTo as ReturnType<typeof vi.fn>).mockClear()
    await act(async () => { setVisibility('visible') })
    await settle()
    expect(fetchNewerPosition).toHaveBeenCalled()
    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})

describe('ADR-019: saves are scoped to their document', () => {
  it('Next within the 1.5 s debounce: the pending save goes to the chapter being left', () => {
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: baseProps() })
    act(() => { scrollBy(3100) })
    act(() => { vi.advanceTimersByTime(500) })
    rerender({ ...baseProps(), chapterIdentifier: 'ch2', chapterLoaded: false })
    expect(locators()).toContain('scroll:ch1:3100')
    expect(locators().filter((l) => l.startsWith('scroll:ch2:'))).toEqual([])
  })

  it('reflow → PDF layout within the debounce: the pending reflow save is dropped', () => {
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: baseProps() })
    const before = locators().length
    act(() => { scrollBy(3100) })
    rerender({ ...baseProps(), originalActive: true })
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { setVisibility('hidden') })
    expect(locators().slice(before)).toEqual([])
  })
})
