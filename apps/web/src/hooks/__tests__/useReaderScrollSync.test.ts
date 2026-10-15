import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { buildTextPosition, serializeTextPosition } from '@textstack/shared'
import { locatorToPosition, type GoToResult } from '@textstack/reader-engine'

// One home for useReaderScrollSync, grouped by the ADR-019 rule each test pins. The bug ids stay in
// the names: R1 / R2 (#193, C1, M4, C2, the highlight hold), R4 (R4-2, R4-4, review #N, round N),
// and Phase 4 slice 1 (the engine positions the reader: restore and the newer-position move are
// `goTo`, the saved place is `current()`, and the engine's own moves are never a save).
//
// The fake engine's goTo behaves like the real one on the page: it moves it at once and the browser
// fires a `scroll` event a frame later — the echo that the first R4 version saved as if the reader
// made it.

const readProgress = vi.fn()
vi.mock('../../api/auth', () => ({ readProgress: (...a: unknown[]) => readProgress(...a) }))
const auth = { isAuthenticated: true, isLoading: false }
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../../api/readingTracking', () => ({ submitSession: vi.fn(async () => ({})) }))
vi.mock('../../lib/analytics', () => ({ trackReadingSessionEnd: vi.fn() }))

import { useReaderScrollSync, isChapterReady } from '../useReaderScrollSync'
import { useRestoreProgress } from '../useRestoreProgress'
import { useReadingSession } from '../useReadingSession'
import type { NewerPositionResult } from '../useReaderProgress'
import { fakeEngine, getScroll, setScroll, userScroll, unmountFakeEngines } from './scrollSync.testkit'

type Props = Parameters<typeof useReaderScrollSync>[0]

const TOP = { href: 'ch1', type: 'text/html', locations: { progression: 0 } }
const atPx = (px: number, href = 'ch1') => ({ href, type: 'text/html', locations: { legacyScrollY: px } })

const TEXT = 'It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith hurried.'
const positionAt = (slug: string, offset: number) =>
  serializeTextPosition(buildTextPosition({ chapterSlug: slug, chapterText: TEXT, charOffset: offset, chapterFraction: 0.3 })!)

const PAGE_MAX = 20_000
function setVisibility(v: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
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
  publicBookChapters: [{ id: 'ch1-id', slug: 'ch1' }, { id: 'ch2-id', slug: 'ch2' }] as Props['publicBookChapters'],
  publicProgress: { updateProgress, flushSave: vi.fn() },
  userProgress: { saveProgress: vi.fn(), flushSave: vi.fn() },
})
const locators = () => updateProgress.mock.calls.map((c) => c[2] as string)
const newer = (locator: string, chapterSlug = 'ch1'): NewerPositionResult => ({ chapterSlug, locator, positionJson: null })

/** Let the engine's goTo land and the save-on-open that follows it run. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(16) })
/**
 * Let pending promises and the scroll echo (a 16 ms "frame") run. Twice: the engine's goTo resolves a
 * render before the restore counts as landed, and the newer-position check starts the render after.
 */
const frame = async () => {
  await act(async () => { await vi.advanceTimersByTimeAsync(16) })
  await act(async () => { await vi.advanceTimersByTimeAsync(16) })
}

let eng: ReturnType<typeof fakeEngine>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  updateProgress.mockReset()
  readProgress.mockReset()
  auth.isAuthenticated = true
  auth.isLoading = false
  localStorage.clear()
  setScroll(0)
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  eng = fakeEngine('ch1')
  eng.state.pageMax = PAGE_MAX
})
afterEach(() => {
  unmountFakeEngines()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

describe('ADR-019 rule 2 — restore once the requested chapter is ready', () => {
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

  describe('useReaderScrollSync with the engine — restore', () => {
    it('restore_SavedTextPosition_EngineGoesToIt', async () => {
      const { engine } = eng
      const json = positionAt('ch1', 35)
      renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { positionJson: json, locator: 'scroll:ch1:900' } }))
      await settle()
      const at = engine.goTo.mock.calls[0][0]
      expect(at.href).toBe('ch1')
      expect(at.text?.highlight).toBe(TEXT.slice(35, 35 + (at.text?.highlight?.length ?? 0)))
      expect(at.locations.legacyScrollY).toBe(900)   // the ladder's last rung before the top
      expect(window.scrollTo).not.toHaveBeenCalled()
    })

    it('restore_LayoutSwitchesBackToReflow_RestoresAgain', async () => {
      // The Original PDF scrolls the window; coming back to reflow must not keep its scrollTop.
      const { engine } = eng
      const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: baseProps() })
      await settle()
      rerender({ ...baseProps(), originalActive: true })
      await settle()
      rerender(baseProps())
      await settle()
      expect(engine.goTo).toHaveBeenCalledTimes(2)
    })

    it('restore_AnotherChaptersPosition_NotUsed', async () => {
      const { engine } = fakeEngine('ch2')
      renderHook(() => useReaderScrollSync({ ...baseProps(), chapterIdentifier: 'ch2', publicBookChapters: [{ id: 'ch2-id', slug: 'ch2' }] as Props['publicBookChapters'], effectiveProgress: { positionJson: positionAt('ch1', 35) } }))
      await settle()
      expect(engine.goTo.mock.calls[0][0]).toEqual({ href: 'ch2', type: 'text/html', locations: { progression: 0 } })
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
})

describe('ADR-019 rule 3 — the open lands, then saves once', () => {
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

  describe('round 2 #5: only THE open is held back', () => {
    it('after an unanswered open, a chapter the reader goes to is saved on open', async () => {
      const props = { ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, serverUnanswered: true }
      const { rerender } = renderHook((p: Props) => useReaderScrollSync(p), { initialProps: props })
      await frame()
      expect(locators()).toEqual([])
      rerender({ ...props, chapterIdentifier: 'ch2', chapterLoaded: false })
      eng.show('ch2')
      rerender({ ...props, chapterIdentifier: 'ch2' })
      await frame()
      expect(locators()).toEqual(['scroll:ch2:0'])
    })
  })
})

describe('ADR-019 rule 4 — a pending save belongs to its document', () => {
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
})

describe('ADR-019 rule 5 — server data enters only as a newer-check', () => {
  describe('the background re-ask after an unanswered open', () => {
    it('the reader has not moved → goes to the newer place, and does not save the server\'s own position back', async () => {
      const fetchNewerPosition = vi.fn(async () => newer('scroll:ch1:7000'))
      renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, serverUnanswered: true, fetchNewerPosition }))
      await frame()
      expect(fetchNewerPosition).toHaveBeenCalledTimes(1)
      expect(getScroll()).toBe(7000)
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
      expect(getScroll()).toBe(4000)
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
      expect(getScroll()).toBe(7000)

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
      expect(getScroll()).toBe(9000)
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
      expect(getScroll()).toBe(4000)
    })

    it('newer in another chapter → web neither navigates nor scrolls', async () => {
      const fetchNewerPosition = vi.fn(async () => newer('scroll:ch2:9000', 'ch2'))
      renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, fetchNewerPosition }))
      await frame()
      eng.engine.goTo.mockClear()
      await act(async () => { setVisibility('visible') })
      await frame()
      expect(fetchNewerPosition).toHaveBeenCalled()
      expect(eng.engine.goTo).not.toHaveBeenCalled()
    })
  })

  describe('review #5: an explicit position beats a newer one', () => {
    it('a ?highlight= jump (markPositioned) is not pulled away', async () => {
      const fetchNewerPosition = vi.fn(async () => newer('scroll:ch1:9000'))
      const { result } = renderHook(() => useReaderScrollSync({ ...baseProps(), holdRestore: true, fetchNewerPosition }))
      act(() => { setScroll(3300) }) // the highlight link lands
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
      eng.show('ch2')
      rerender({ ...props, chapterIdentifier: 'ch2' })
      await frame()
      expect(seen?.aborted).toBe(true)
      eng.engine.goTo.mockClear()
      await act(async () => { answer(newer('scroll:ch1:9000')) })
      expect(eng.engine.goTo).not.toHaveBeenCalled()
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

    it('a visible that started no check (one was in flight) does not use up the throttle', async () => {
      let finish!: (r: NewerPositionResult) => void
      const fetchNewerPosition = vi.fn(() => new Promise<NewerPositionResult>((r) => { finish = r }))
      renderHook(() => useReaderScrollSync({ ...baseProps(), serverUnanswered: true, fetchNewerPosition }))
      await frame()
      await act(async () => { setVisibility('visible') }) // the late check is in flight: nothing starts
      await act(async () => { finish(null) })
      await act(async () => { setVisibility('visible') })
      expect(fetchNewerPosition).toHaveBeenCalledTimes(2)
    })
  })

  describe('useReaderScrollSync with the engine — review fixes', () => {
    it('restore_SupersededByANewerRestore_OnlyTheNewerOneLands', async () => {
      const { engine } = eng
      engine.goTo.mockImplementationOnce(async () => 'superseded' as GoToResult)
      renderHook(() => useReaderScrollSync(baseProps()))
      await settle()
      // The superseded goTo did not mark the chapter restored: no save-on-open from a mid-move place.
      expect(updateProgress).not.toHaveBeenCalled()
    })

    it('engineMove_AfterAHighlightLinkPositioned_IsNotTheReaders', async () => {
      const { emit, state } = eng
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
      const { engine, emit, state } = eng
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
      const { engine } = eng
      const fetchNewerPosition = vi.fn(async (): Promise<NewerPositionResult> => ({ chapterSlug: 'ch1', locator: 'scroll:ch1:0', positionJson: null }))
      renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:500' }, serverUnanswered: true, fetchNewerPosition }))
      await settle()
      await settle()
      expect(engine.goTo).toHaveBeenCalledTimes(2)
      expect(engine.goTo.mock.calls[1][0]).toEqual({ href: 'ch1', type: 'text/html', locations: { progression: 0 } })
    })
  })
})

describe('ADR-019 rule 6 — every wait has a deadline', () => {
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
      expect(eng.engine.goTo).not.toHaveBeenCalled()

      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(getScroll()).toBe(2000)
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
      expect(getScroll()).toBe(900)
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
})

describe('ADR-019 rule 7 — a programmatic move is not reading', () => {
  describe('useReaderScrollSync with the engine — save', () => {
    it('save_OnOpen_WritesTheEnginesPlace', async () => {
      const { state } = eng
      const json = positionAt('ch1', 35)
      renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { positionJson: json } }))
      await settle()
      expect(updateProgress).toHaveBeenCalledTimes(1)
      expect(updateProgress.mock.calls[0][5]).toBe(locatorToPosition(state.here))
    })

    it('save_ReaderScroll_WritesTheEnginesCurrentPlace', async () => {
      const { state } = eng
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
      const { emit, state } = eng
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

  describe("round 3: mobile's rule — every scroll but our own is the reader's", () => {
    it('a scroll with no input event at all (scrollbar drag, Ctrl+F jump) IS saved and IS reading', async () => {
      const onReaderScroll = vi.fn()
      renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, onReaderScroll }))
      await frame()
      act(() => { userScroll(5200) }) // no wheel/touch/key/pointer event precedes it
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(locators()[locators().length - 1]).toBe('scroll:ch1:5200')
      expect(onReaderScroll).toHaveBeenCalled()
    })

    it('the re-anchor after a font change (and the webfont reflow after it) is not saved and is not "moved"', async () => {
      // H2: the engine keeps the reading line through a style change (E6); its move is ours, not the reader's.
      let answer!: (r: NewerPositionResult) => void
      const fetchNewerPosition = vi.fn(() => new Promise<NewerPositionResult>((r) => { answer = r }))
      renderHook(() => useReaderScrollSync({ ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, fetchNewerPosition }))
      await frame()
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(getScroll()).toBe(2000)
      const before = locators().length

      const reanchor = (top: number, reason: 'style' | 'reflow') => act(() => {
        setScroll(top)
        eng.emit('relocated', { locator: eng.state.here!, reason })
        window.dispatchEvent(new Event('scroll'))
      })
      reanchor(2400, 'style')    // a bigger font pushes the text down; the engine keeps it on the line
      reanchor(2700, 'reflow')   // the webfont lands: the chapter reflows again
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(locators().slice(before)).toEqual([])

      // Not "moved" (700 px from the restore, yet ours): a newer position from elsewhere applies.
      await act(async () => { setVisibility('visible') })
      await act(async () => { answer(newer('scroll:ch1:9000')) })
      expect(getScroll()).toBe(9000)
    })

    it('after an unanswered open, a small shift (scroll anchoring) is not saved; a real move is', async () => {
      const props = { ...baseProps(), effectiveProgress: { locator: 'scroll:ch1:2000' }, serverUnanswered: true }
      renderHook(() => useReaderScrollSync(props))
      await frame()
      act(() => { userScroll(2030) }) // an image above settled: inside the 48 px tolerance
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(locators()).toEqual([])
      act(() => { userScroll(2600) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(locators()).toEqual(['scroll:ch1:2600'])
    })
  })
})
