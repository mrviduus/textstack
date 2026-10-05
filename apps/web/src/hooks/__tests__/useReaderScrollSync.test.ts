import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReaderScrollSync, isChapterReady } from '../useReaderScrollSync'

// rAF runs sync in tests so window.scrollTo fires within renderHook.
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // Tests that simulate a real scrollTo mutate the shared scrollingElement.scrollTop — reset it so
  // it can't leak a non-zero offset into the next test.
  const el = (document.scrollingElement || document.documentElement) as HTMLElement
  try {
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true })
  } catch {
    // ignore if not redefinable
  }
})

const noopProgress = {
  updateProgress: vi.fn(),
  flushSave: vi.fn(),
}
const noopUserProgress = {
  saveProgress: vi.fn(),
  flushSave: vi.fn(),
}

type Props = Parameters<typeof useReaderScrollSync>[0]

const baseProps: Props = {
  mode: 'public',
  chapterIdentifier: 'ch1',
  chapterLoaded: true,
  originalActive: false,
  overallProgress: 0,
  effectiveProgress: null,
  effectiveLoading: false,
  publicBookChapters: [{ id: 'ch1-id', slug: 'ch1' }] as any,
  publicProgress: noopProgress,
  userProgress: noopUserProgress,
  settingsKey: '18 1.6 serif left',
}

describe('useReaderScrollSync — scroll restore', () => {
  it('scrolls to top when no saved progress', () => {
    renderHook(() => useReaderScrollSync(baseProps))
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })

  it('scrolls to top when locator does not start with scroll:', () => {
    renderHook(() =>
      useReaderScrollSync({ ...baseProps, effectiveProgress: { locator: 'percent:0.5' } }),
    )
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })

  it('scrolls to top when locator chapter slug does not match current chapter', () => {
    renderHook(() =>
      useReaderScrollSync({
        ...baseProps,
        chapterIdentifier: 'ch2',
        effectiveProgress: { locator: 'scroll:ch1:5000' },
      }),
    )
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })

  it('scrolls to top when locator is malformed (parts < 3)', () => {
    renderHook(() =>
      useReaderScrollSync({ ...baseProps, effectiveProgress: { locator: 'scroll:ch1' } }),
    )
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })

  it('scrolls to top when offset is NaN', () => {
    renderHook(() =>
      useReaderScrollSync({ ...baseProps, effectiveProgress: { locator: 'scroll:ch1:abc' } }),
    )
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })

  it('restores to saved offset when locator chapter matches', () => {
    renderHook(() =>
      useReaderScrollSync({
        ...baseProps,
        effectiveProgress: { locator: 'scroll:ch1:5000' },
      }),
    )
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 5000, behavior: 'instant' })
  })

  it('does not restore while effectiveLoading', () => {
    renderHook(() =>
      useReaderScrollSync({
        ...baseProps,
        effectiveLoading: true,
        effectiveProgress: { locator: 'scroll:ch1:5000' },
      }),
    )
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('does not restore while chapter not loaded', () => {
    renderHook(() =>
      useReaderScrollSync({
        ...baseProps,
        chapterLoaded: false,
        effectiveProgress: { locator: 'scroll:ch1:5000' },
      }),
    )
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('on chapter change with stale locator (savedSlug=ch1, new=ch2) → scrolls to top', () => {
    // Simulates the bug PR #193 fixed: user clicks Next at the bottom of ch1,
    // chapterIdentifier flips to ch2, locator still points at ch1.
    const { rerender } = renderHook((props: Props) => useReaderScrollSync(props), {
      initialProps: { ...baseProps, effectiveProgress: { locator: 'scroll:ch1:8000' } },
    })
    // First render restored to saved offset.
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 8000, behavior: 'instant' })
    ;(window.scrollTo as any).mockClear()

    rerender({
      ...baseProps,
      chapterIdentifier: 'ch2',
      effectiveProgress: { locator: 'scroll:ch1:8000' },
    })
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })
})

describe('useReaderScrollSync — save on chapter open', () => {
  it('fires exactly one public save when a chapter opens (after restore)', () => {
    const updateProgress = vi.fn()
    const props: Props = {
      ...baseProps,
      publicProgress: { updateProgress, flushSave: vi.fn() },
    }
    renderHook(() => useReaderScrollSync(props))

    expect(updateProgress).toHaveBeenCalledTimes(1)
    // (progress, page, scrollLocator, chapterId, chapterSlug)
    expect(updateProgress).toHaveBeenCalledWith(0, undefined, 'scroll:ch1:0', 'ch1-id', 'ch1', undefined)
  })

  it('fires one userbook save when a chapter opens', () => {
    const saveProgress = vi.fn()
    const props: Props = {
      ...baseProps,
      mode: 'userbook',
      publicBookChapters: undefined,
      userProgress: { saveProgress, flushSave: vi.fn() },
    }
    renderHook(() => useReaderScrollSync(props))

    expect(saveProgress).toHaveBeenCalledTimes(1)
    expect(saveProgress).toHaveBeenCalledWith('ch1', 0, 0, 'scroll:ch1:0', undefined)
  })

  it('saves once per chapter on navigation (ch1 → ch2)', () => {
    const updateProgress = vi.fn()
    const props: Props = {
      ...baseProps,
      publicBookChapters: [
        { id: 'ch1-id', slug: 'ch1' },
        { id: 'ch2-id', slug: 'ch2' },
      ] as any,
      publicProgress: { updateProgress, flushSave: vi.fn() },
    }
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), {
      initialProps: props,
    })
    expect(updateProgress).toHaveBeenCalledTimes(1)
    expect(updateProgress).toHaveBeenLastCalledWith(0, undefined, 'scroll:ch1:0', 'ch1-id', 'ch1', undefined)

    rerender({ ...props, chapterIdentifier: 'ch2' })
    expect(updateProgress).toHaveBeenCalledTimes(2)
    expect(updateProgress).toHaveBeenLastCalledWith(0, undefined, 'scroll:ch2:0', 'ch2-id', 'ch2', undefined)
  })

  it('does not save before chapter is loaded', () => {
    const updateProgress = vi.fn()
    renderHook(() =>
      useReaderScrollSync({
        ...baseProps,
        chapterLoaded: false,
        publicProgress: { updateProgress, flushSave: vi.fn() },
      }),
    )
    expect(updateProgress).not.toHaveBeenCalled()
  })

  // CLOBBER GUARD: the save-on-open must read scrollTop AFTER window.scrollTo restored it,
  // never a transient 0. If it captured 0 here, the next load would restore to the top and the
  // reader would silently lose their place. We make scrollTo actually move scrollingElement.scrollTop
  // (jsdom's default scrollTo is a no-op) so the save reflects the RESTORED offset.
  it('save-on-open captures the RESTORED offset, not a transient 0', () => {
    const scrollEl = (document.scrollingElement || document.documentElement) as HTMLElement
    Object.defineProperty(scrollEl, 'scrollTop', { value: 0, writable: true, configurable: true })
    window.scrollTo = vi.fn((arg: any) => {
      // Mirror real browser behaviour: scrollTo updates scrollTop synchronously.
      ;(scrollEl as any).scrollTop = typeof arg === 'object' ? arg.top : arg
    }) as unknown as typeof window.scrollTo

    const updateProgress = vi.fn()
    renderHook(() =>
      useReaderScrollSync({
        ...baseProps,
        effectiveProgress: { locator: 'scroll:ch1:5000' },
        publicProgress: { updateProgress, flushSave: vi.fn() },
      }),
    )

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 5000, behavior: 'instant' })
    // The leak/clobber assertion: the open-save must record the RESTORED offset 5000, and must NEVER
    // record a transient 0 for ch1 (a 0 here would persist top-of-chapter and lose the reader's place).
    const locators = updateProgress.mock.calls.map(c => c[2] as string)
    expect(locators).toContain('scroll:ch1:5000')
    expect(locators).not.toContain('scroll:ch1:0')
  })

  // Re-render that does NOT change the chapter (e.g. overallProgress ticks) must not re-fire the
  // open-save: exactly-once per opened chapter, else every render double-writes.
  it('does not re-fire save-on-open on a same-chapter re-render', () => {
    const updateProgress = vi.fn()
    const props: Props = {
      ...baseProps,
      publicProgress: { updateProgress, flushSave: vi.fn() },
    }
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: props })
    expect(updateProgress).toHaveBeenCalledTimes(1)

    // Same chapter, only overallProgress moved — open-save must stay armed-off.
    rerender({ ...props, overallProgress: 0.42 })
    expect(updateProgress).toHaveBeenCalledTimes(1)
  })

  // Re-arm guard: navigating away and BACK to the same chapter must save again (the once-guard is
  // reset on chapter change), not stay permanently suppressed.
  it('re-arms save-on-open when returning to a previously-opened chapter', () => {
    const updateProgress = vi.fn()
    const props: Props = {
      ...baseProps,
      publicBookChapters: [
        { id: 'ch1-id', slug: 'ch1' },
        { id: 'ch2-id', slug: 'ch2' },
      ] as any,
      publicProgress: { updateProgress, flushSave: vi.fn() },
    }
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: props })
    expect(updateProgress).toHaveBeenCalledTimes(1)

    rerender({ ...props, chapterIdentifier: 'ch2' })
    expect(updateProgress).toHaveBeenCalledTimes(2)

    rerender({ ...props, chapterIdentifier: 'ch1' })
    // Re-armed: a third write for ch1 (id + slug correct). Offset value isn't asserted here — it's
    // exercised by the dedicated clobber test above; this case only proves the once-guard re-arms.
    expect(updateProgress).toHaveBeenCalledTimes(3)
    const last = updateProgress.mock.calls[updateProgress.mock.calls.length - 1]
    expect(last[3]).toBe('ch1-id')
    expect(last[4]).toBe('ch1')
  })
})

describe('useReaderScrollSync — Original-layout PDF', () => {
  it('neither restores nor saves while the PDF viewer owns the position', () => {
    // This hook writes scroll:<identifier>:<offset>. A PDF read in Original
    // layout stores page:<n>, and they are different coordinate spaces — one
    // written over the other loses the reader's place.
    //
    // It hides better here than on mobile: an uploaded PDF usually HAS reflow
    // chapters, so the chapter fetch succeeds in Original layout, chapterLoaded
    // is true, and the save-on-open fires while the reader is looking at pages.
    const userProgress = { saveProgress: vi.fn(), flushSave: vi.fn() }
    const publicProgress = { updateProgress: vi.fn(), flushSave: vi.fn() }

    renderHook(() =>
      useReaderScrollSync({
        ...baseProps,
        mode: 'userbook',
        originalActive: true,
        effectiveProgress: { locator: 'scroll:ch1:4200' },
        userProgress,
        publicProgress,
      }),
    )

    expect(userProgress.saveProgress).not.toHaveBeenCalled()
    expect(publicProgress.updateProgress).not.toHaveBeenCalled()
    // And it must not drag the page to a scroll offset the PDF viewer did not ask for.
    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})

describe('useReaderScrollSync — the shared locator parser', () => {
  it('restores from a slug containing a colon', () => {
    // This hook used to split(':') inline, so `scroll:act-i:scene-ii:900` gave a
    // slug of "act-i" and an offset of NaN -> 0. The shared parseScrollLocator
    // reads from the RIGHT precisely because a chapter slug is derived from a
    // user-supplied title and can contain anything a title can.
    renderHook(() =>
      useReaderScrollSync({
        ...baseProps,
        chapterIdentifier: 'act-i:scene-ii',
        effectiveProgress: { locator: 'scroll:act-i:scene-ii:900' },
      }),
    )
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'instant' })
  })

  it('still ignores a locator naming a different chapter', () => {
    renderHook(() =>
      useReaderScrollSync({
        ...baseProps,
        chapterIdentifier: 'ch2',
        effectiveProgress: { locator: 'scroll:ch1:900' },
      }),
    )
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })

  it('ignores a position belonging to another chapter, and falls back to the locator', () => {
    // The substitution the whole position model exists to prevent: a position
    // for chapter two must never be applied to chapter one.
    const foreign = JSON.stringify({
      v: 1, chapterSlug: 'ch2', charOffset: 10, chapterFraction: 0.5,
      anchor: { prefix: '', exact: 'anything', suffix: '', startOffset: 10, endOffset: 18 },
    })
    renderHook(() =>
      useReaderScrollSync({
        ...baseProps,
        chapterIdentifier: 'ch1',
        effectiveProgress: { locator: 'scroll:ch1:640', positionJson: foreign },
      }),
    )
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 640, behavior: 'instant' })
  })
})

// ── R1: C1 / M4 / C2 ────────────────────────────────────────────────────────
function setScroll(top: number) {
  const el = (document.scrollingElement || document.documentElement) as HTMLElement
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true })
}
function realScrollTo() {
  window.scrollTo = vi.fn((arg: any) => setScroll(typeof arg === 'object' ? arg.top : arg)) as unknown as typeof window.scrollTo
}
function scrollBy(top: number) {
  setScroll(top)
  window.dispatchEvent(new Event('scroll'))
}

describe('useReaderScrollSync — trailing save (C1)', () => {
  afterEach(() => vi.useRealTimers())

  it('saves the LAST scroll position, even inside the first 2s after open', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    realScrollTo()
    const updateProgress = vi.fn()
    const props: Props = { ...baseProps, publicProgress: { updateProgress, flushSave: vi.fn() } }
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: props })
    expect(updateProgress).toHaveBeenCalledTimes(1) // open-save

    // ReaderPage re-renders with a new overallProgress on every scroll.
    act(() => { scrollBy(1000) }); rerender({ ...props, overallProgress: 0.1 })
    act(() => { vi.advanceTimersByTime(300) })
    act(() => { scrollBy(3000) }); rerender({ ...props, overallProgress: 0.3 })
    act(() => { vi.advanceTimersByTime(3000) })

    const locators = updateProgress.mock.calls.map(c => c[2])
    expect(locators[locators.length - 1]).toBe('scroll:ch1:3000')
  })

  it('saves a scroll UP (overallProgress is monotonic and does not move)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    realScrollTo()
    const updateProgress = vi.fn()
    const props: Props = { ...baseProps, overallProgress: 0.5, publicProgress: { updateProgress, flushSave: vi.fn() } }
    renderHook((p: Props) => useReaderScrollSync(p), { initialProps: props })
    act(() => { vi.advanceTimersByTime(5000) })
    act(() => { scrollBy(5000) })
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { scrollBy(1200) })
    act(() => { vi.advanceTimersByTime(3000) })
    const locators = updateProgress.mock.calls.map(c => c[2])
    expect(locators[locators.length - 1]).toBe('scroll:ch1:1200')
  })

  it('flushes the pending position with keepalive when the tab is hidden', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    realScrollTo()
    const updateProgress = vi.fn()
    const flushSave = vi.fn()
    renderHook(() => useReaderScrollSync({ ...baseProps, publicProgress: { updateProgress, flushSave } }))
    act(() => { scrollBy(4000) })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    expect(updateProgress).toHaveBeenLastCalledWith(0, undefined, 'scroll:ch1:4000', 'ch1-id', 'ch1', undefined)
    expect(flushSave).toHaveBeenCalled()
  })
})

describe('useReaderScrollSync — no write storm on re-render (M4)', () => {
  it('N re-renders with fresh progress objects → 0 extra writes, 0 keepalive flushes', () => {
    const saveProgress = vi.fn()
    const flushSave = vi.fn()
    const props: Props = { ...baseProps, mode: 'userbook', publicBookChapters: undefined }
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), {
      initialProps: { ...props, userProgress: { saveProgress, flushSave } },
    })
    expect(saveProgress).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 10; i++) {
      rerender({ ...props, userProgress: { saveProgress, flushSave } })
    }
    expect(saveProgress).toHaveBeenCalledTimes(1)
    expect(flushSave).not.toHaveBeenCalled()
  })
})

describe('useReaderScrollSync — Next → Prev (C2)', () => {
  afterEach(() => vi.useRealTimers())

  it('returns to where the reader left the chapter, not the stale position fetched at open', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    realScrollTo()
    const updateProgress = vi.fn()
    const props: Props = {
      ...baseProps,
      publicBookChapters: [{ id: 'ch1-id', slug: 'ch1' }, { id: 'ch2-id', slug: 'ch2' }] as any,
      effectiveProgress: { locator: 'scroll:ch1:3000' }, // fetched once per book
      publicProgress: { updateProgress, flushSave: vi.fn() },
    }
    const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: props })
    act(() => { scrollBy(6000) })
    act(() => { vi.advanceTimersByTime(3000) })

    // Next: identifier flips, the new chapter is still loading.
    rerender({ ...props, chapterIdentifier: 'ch2', chapterLoaded: false })
    setScroll(0)
    rerender({ ...props, chapterIdentifier: 'ch2', chapterLoaded: true })
    // Prev
    rerender({ ...props, chapterIdentifier: 'ch1', chapterLoaded: false })
    ;(window.scrollTo as any).mockClear()
    rerender({ ...props, chapterIdentifier: 'ch1', chapterLoaded: true })

    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 6000, behavior: 'instant' })
    const ch1Writes = updateProgress.mock.calls.map(c => c[2] as string).filter(l => l.startsWith('scroll:ch1:'))
    expect(ch1Writes[ch1Writes.length - 1]).toBe('scroll:ch1:6000')
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
