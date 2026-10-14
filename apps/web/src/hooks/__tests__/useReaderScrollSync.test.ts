import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReaderScrollSync, isChapterReady } from '../useReaderScrollSync'
import { fakeEngine, setScroll, userScroll, unmountFakeEngines } from './scrollSync.testkit'

// R1 / R2 pins (restore, save-on-open, C1 / M4 / C2, the highlight hold), on the engine path (Phase 6):
// the engine positions the reader (`goTo`), this hook decides where and when, and what is saved.

type Props = Parameters<typeof useReaderScrollSync>[0]

const TOP = { href: 'ch1', type: 'text/html', locations: { progression: 0 } }
const atPx = (px: number, href = 'ch1') => ({ href, type: 'text/html', locations: { legacyScrollY: px } })

const updateProgress = vi.fn()
const baseProps = (): Props => ({
  mode: 'public',
  chapterIdentifier: 'ch1',
  chapterLoaded: true,
  originalActive: false,
  overallProgress: 0,
  effectiveProgress: null,
  effectiveLoading: false,
  publicBookChapters: [{ id: 'ch1-id', slug: 'ch1' }, { id: 'ch2-id', slug: 'ch2' }] as Props['publicBookChapters'],
  publicProgress: { updateProgress, flushSave: vi.fn() },
  userProgress: { saveProgress: vi.fn(), flushSave: vi.fn() },
})
const locators = () => updateProgress.mock.calls.map((c) => c[2] as string)
/** Let the engine's goTo land and the save-on-open that follows it run. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(16) })

let eng: ReturnType<typeof fakeEngine>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  updateProgress.mockReset()
  setScroll(0)
  eng = fakeEngine('ch1')
})
afterEach(() => {
  unmountFakeEngines()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useReaderScrollSync — scroll restore', () => {
  it('goes to the top when nothing is saved', async () => {
    renderHook(() => useReaderScrollSync(baseProps()))
    await settle()
    expect(eng.engine.goTo).toHaveBeenCalledWith(TOP)
  })

  it.each([
    ['not a scroll: locator', 'percent:0.5'],
    ['another chapter', 'scroll:ch9:5000'],
    ['malformed (parts < 3)', 'scroll:ch1'],
    ['offset is NaN', 'scroll:ch1:abc'],
  ])('goes to the top when the locator is %s', async (_name, locator) => {
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator } }))
    await settle()
    expect(eng.engine.goTo).toHaveBeenCalledWith(TOP)
  })

  it('goes to the saved offset when the locator names this chapter', async () => {
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:5000' } }))
    await settle()
    expect(eng.engine.goTo).toHaveBeenCalledWith(atPx(5000))
  })

  it.each([
    ['effectiveLoading', { effectiveLoading: true }],
    ['the chapter is not loaded', { chapterLoaded: false }],
  ])('does not restore while %s', async (_name, over) => {
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:5000' }, ...over }))
    await settle()
    expect(eng.engine.goTo).not.toHaveBeenCalled()
  })

  it('on chapter change with a stale locator (savedSlug=ch1, new=ch2) → the top of ch2 (#193)', async () => {
    // The user clicks Next at the bottom of ch1; chapterIdentifier flips to ch2, the locator still points at ch1.
    const props = { ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:8000' } }
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: props })
    await settle()
    expect(eng.engine.goTo).toHaveBeenLastCalledWith(atPx(8000))
    eng.show('ch2')
    rerender({ ...props, chapterIdentifier: 'ch2' })
    await settle()
    expect(eng.engine.goTo).toHaveBeenLastCalledWith({ ...TOP, href: 'ch2' })
  })
})

describe('useReaderScrollSync — save on chapter open', () => {
  it('fires exactly one public save when a chapter opens (after restore)', async () => {
    renderHook(() => useReaderScrollSync(baseProps()))
    await settle()
    // (progress, page, scrollLocator, chapterId, chapterSlug, positionJson)
    expect(updateProgress.mock.calls).toEqual([[0, undefined, 'scroll:ch1:0', 'ch1-id', 'ch1', undefined]])
  })

  it('fires one userbook save when a chapter opens', async () => {
    const saveProgress = vi.fn()
    renderHook(() => useReaderScrollSync({ ...baseProps(), mode: 'userbook', publicBookChapters: undefined, userProgress: { saveProgress, flushSave: vi.fn() } }))
    await settle()
    expect(saveProgress.mock.calls).toEqual([['ch1', 0, 0, 'scroll:ch1:0', undefined]])
  })

  it('saves once per chapter on navigation (ch1 → ch2)', async () => {
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: baseProps() })
    await settle()
    eng.show('ch2')
    rerender({ ...baseProps(), chapterIdentifier: 'ch2' })
    await settle()
    expect(updateProgress.mock.calls).toEqual([
      [0, undefined, 'scroll:ch1:0', 'ch1-id', 'ch1', undefined],
      [0, undefined, 'scroll:ch2:0', 'ch2-id', 'ch2', undefined],
    ])
  })

  it('does not save before the chapter is loaded', async () => {
    renderHook(() => useReaderScrollSync({ ...baseProps(), chapterLoaded: false }))
    await settle()
    expect(updateProgress).not.toHaveBeenCalled()
  })

  // CLOBBER GUARD: the save-on-open reads scrollTop AFTER the engine landed the restore, never a
  // transient 0 — a 0 here would persist top-of-chapter and the reader would silently lose their place.
  it('save-on-open captures the RESTORED offset, not a transient 0', async () => {
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:5000' } }))
    await settle()
    expect(locators()).toContain('scroll:ch1:5000')
    expect(locators()).not.toContain('scroll:ch1:0')
  })

  it('does not re-fire save-on-open on a same-chapter re-render', async () => {
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: baseProps() })
    await settle()
    rerender({ ...baseProps(), overallProgress: 0.42 })
    await settle()
    expect(updateProgress).toHaveBeenCalledTimes(1)
  })

  it('re-arms save-on-open when returning to a previously-opened chapter', async () => {
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: baseProps() })
    await settle()
    eng.show('ch2')
    rerender({ ...baseProps(), chapterIdentifier: 'ch2' })
    await settle()
    eng.show('ch1')
    rerender(baseProps())
    await settle()
    expect(updateProgress).toHaveBeenCalledTimes(3)
    expect(updateProgress.mock.lastCall!.slice(3, 5)).toEqual(['ch1-id', 'ch1'])
  })
})

describe('useReaderScrollSync — Original-layout PDF', () => {
  it('neither restores nor saves while the PDF view owns the position', async () => {
    // This hook writes scroll:<identifier>:<offset>; a PDF in Original layout stores page:<n> — one written
    // over the other loses the reader's place. An uploaded PDF usually HAS reflow chapters, so
    // chapterLoaded is true and the save-on-open would fire while the reader is looking at pages.
    const saveProgress = vi.fn()
    renderHook(() => useReaderScrollSync({
      ...baseProps(), mode: 'userbook', originalActive: true, effectiveProgress: { locator: 'scroll:ch1:4200' },
      userProgress: { saveProgress, flushSave: vi.fn() },
    }))
    await settle()
    expect(saveProgress).not.toHaveBeenCalled()
    expect(updateProgress).not.toHaveBeenCalled()
    expect(eng.engine.goTo).not.toHaveBeenCalled()
  })
})

describe('useReaderScrollSync — the shared locator parser', () => {
  it('restores from a slug containing a colon', async () => {
    // This hook used to split(':') inline, so `scroll:act-i:scene-ii:900` gave a slug of "act-i" and an
    // offset of NaN -> 0. The shared parseScrollLocator reads from the RIGHT: a chapter slug is derived
    // from a user-supplied title and can contain anything a title can.
    eng.show('act-i:scene-ii')
    renderHook(() => useReaderScrollSync({ ...baseProps(), chapterIdentifier: 'act-i:scene-ii', effectiveProgress: { locator: 'scroll:act-i:scene-ii:900' } }))
    await settle()
    expect(eng.engine.goTo).toHaveBeenCalledWith(atPx(900, 'act-i:scene-ii'))
  })

  it('ignores a position belonging to another chapter, and falls back to the locator', async () => {
    // The substitution the whole position model exists to prevent: a position for chapter two must
    // never be applied to chapter one.
    const foreign = JSON.stringify({
      v: 1, chapterSlug: 'ch2', charOffset: 10, chapterFraction: 0.5,
      anchor: { prefix: '', exact: 'anything', suffix: '', startOffset: 10, endOffset: 18 },
    })
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:640', positionJson: foreign } }))
    await settle()
    expect(eng.engine.goTo).toHaveBeenCalledWith(atPx(640))
  })
})

describe('useReaderScrollSync — trailing save (C1)', () => {
  it('saves the LAST scroll position, even inside the first 2s after open', async () => {
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: baseProps() })
    await settle()
    // ReaderPage re-renders with a new overallProgress on every scroll.
    act(() => { userScroll(1000) }); rerender({ ...baseProps(), overallProgress: 0.1 })
    act(() => { vi.advanceTimersByTime(300) })
    act(() => { userScroll(3000) }); rerender({ ...baseProps(), overallProgress: 0.3 })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(locators().pop()).toBe('scroll:ch1:3000')
  })

  it('saves a scroll UP (overallProgress is monotonic and does not move)', async () => {
    renderHook(() => useReaderScrollSync({ ...baseProps(), overallProgress: 0.5 }))
    await settle()
    act(() => { userScroll(5000) })
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { userScroll(1200) })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(locators().pop()).toBe('scroll:ch1:1200')
  })

  it('flushes the pending position with keepalive when the tab is hidden', async () => {
    const flushSave = vi.fn()
    renderHook(() => useReaderScrollSync({ ...baseProps(), publicProgress: { updateProgress, flushSave } }))
    await settle()
    act(() => { userScroll(4000) })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    expect(updateProgress).toHaveBeenLastCalledWith(0, undefined, 'scroll:ch1:4000', 'ch1-id', 'ch1', undefined)
    expect(flushSave).toHaveBeenCalled()
  })
})

describe('useReaderScrollSync — no write storm on re-render (M4)', () => {
  it('N re-renders with fresh progress objects → 0 extra writes, 0 keepalive flushes', async () => {
    const saveProgress = vi.fn()
    const flushSave = vi.fn()
    const props = (): Props => ({ ...baseProps(), mode: 'userbook', publicBookChapters: undefined, userProgress: { saveProgress, flushSave } })
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: props() })
    await settle()
    expect(saveProgress).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 10; i++) rerender(props())
    expect(saveProgress).toHaveBeenCalledTimes(1)
    expect(flushSave).not.toHaveBeenCalled()
  })
})

describe('useReaderScrollSync — Next → Prev (C2)', () => {
  /** Read ch1 to 6000, go Next to ch2 (which loads after the URL flips). */
  async function readCh1ThenNext(props: Props) {
    const view = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: props })
    await settle()
    act(() => { userScroll(6000) })
    act(() => { vi.advanceTimersByTime(3000) })
    view.rerender({ ...props, chapterIdentifier: 'ch2', chapterLoaded: false })
    eng.show('ch2')
    view.rerender({ ...props, chapterIdentifier: 'ch2' })
    await settle()
    return view
  }

  it('returns to where the reader left the chapter, not the stale position fetched at open', async () => {
    const props = { ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:3000' } } // fetched once per book
    const { rerender } = await readCh1ThenNext(props)
    rerender({ ...props, chapterIdentifier: 'ch1', chapterLoaded: false })
    eng.show('ch1')
    rerender(props)
    await settle()
    expect(eng.engine.goTo).toHaveBeenLastCalledWith(atPx(6000))
    expect(locators().filter((l) => l.startsWith('scroll:ch1:')).pop()).toBe('scroll:ch1:6000')
  })

  it('a save in chapter II (the book record now names II) does not cost chapter I its place', async () => {
    const props = { ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:3000' } }
    const { rerender } = await readCh1ThenNext(props)
    // Read on in II and let the save land; the one per-book record now points at II.
    act(() => { userScroll(2500) })
    act(() => { vi.advanceTimersByTime(3000) })
    const ch2Record = { locator: 'scroll:ch2:2500' }
    rerender({ ...props, effectiveProgress: ch2Record, chapterIdentifier: 'ch2' })
    rerender({ ...props, effectiveProgress: ch2Record, chapterIdentifier: 'ch1', chapterLoaded: false })
    eng.show('ch1')
    rerender({ ...props, effectiveProgress: ch2Record, chapterIdentifier: 'ch1' })
    await settle()
    expect(eng.engine.goTo).toHaveBeenLastCalledWith(atPx(6000))
  })
})

describe('isChapterReady (C2)', () => {
  it('is false while the previous chapter is still in state', () => {
    expect(isChapterReady({ identifier: '2-ii' }, '3-iii', true)).toBe(false)
    expect(isChapterReady({ identifier: '2-ii' }, '3-iii', false)).toBe(false)
    expect(isChapterReady({ identifier: '3-iii' }, '3-iii', true)).toBe(false)
    expect(isChapterReady(null, '3-iii', false)).toBe(false)
    expect(isChapterReady({ identifier: '3-iii' }, '3-iii', false)).toBe(true)
  })
})

// ── R2 review #4: ?highlight= holds restore and save-on-open ───────────────
describe('useReaderScrollSync — highlight link holds restore', () => {
  const props = () => ({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:5000' } })

  it('held: no restore, no save; released (highlight not found) → normal restore, saved position kept', async () => {
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: { ...props(), holdRestore: true } })
    await settle()
    expect(eng.engine.goTo).not.toHaveBeenCalled()
    expect(updateProgress).not.toHaveBeenCalled()
    rerender({ ...props(), holdRestore: false })
    await settle()
    expect(eng.engine.goTo).toHaveBeenCalledWith(atPx(5000))
    expect(locators()).toEqual(['scroll:ch1:5000'])
  })

  it('jump landed (markPositioned): no restore over it; save-on-open records the jump position', async () => {
    const { result, rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: { ...props(), holdRestore: true } })
    setScroll(1234) // the jump
    act(() => result.current.markPositioned())
    rerender({ ...props(), holdRestore: false })
    await settle()
    expect(eng.engine.goTo).not.toHaveBeenCalled()
    expect(locators()).toEqual(['scroll:ch1:1234'])
  })
})

// R2 third review #3: every hold has a deadline.
describe('useReaderScrollSync — the highlight hold has a deadline', () => {
  it('a link that never resolves releases after 5s: normal restore runs and the reader is told', async () => {
    const onHoldExpired = vi.fn()
    renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:5000' }, holdRestore: true, onHoldExpired }))
    await act(async () => { await vi.advanceTimersByTimeAsync(4900) })
    expect(eng.engine.goTo).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(onHoldExpired).toHaveBeenCalledTimes(1)
    expect(eng.engine.goTo).toHaveBeenCalledWith(atPx(5000))
    expect(locators()[0]).toBe('scroll:ch1:5000')
  })
})
