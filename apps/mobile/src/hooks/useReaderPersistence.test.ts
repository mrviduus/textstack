// @vitest-environment jsdom
/**
 * Behaviour tests for the reader's position persistence, driven through the real hooks.
 *
 * Mounted together as ReaderShell wires them — useReaderPersistence + useReaderSessionFeed +
 * useReaderMessages + useReaderDocument + useReaderChapterNav — behind a fake WebView: injected JS
 * is recorded, and the test plays the bridge, posting `progress` / `restored` / `chapterEnd` /
 * `pdf*` messages through the real onMessage. `loadEnd()` is ReaderShell's reflow onLoadEnd.
 * Rule names (C1, R4 review #1/#2, H3, rule 8) are those of the source comments.
 */
import { act, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextPosition } from '@textstack/shared'
import { renderHook } from '../test/renderHook'
import { useReaderPersistence } from './useReaderPersistence'
import { forgetChapterPositions } from '../lib/positionHandoff'
import { useReaderSessionFeed } from '../components/reader/useReaderSessionFeed'
import { useReaderMessages } from '../components/reader/useReaderMessages'
import { useReaderDocument } from '../components/reader/useReaderDocument'
import { useReaderChapterNav } from '../components/reader/useReaderChapterNav'
import type { NewerPosition, ProgressSnapshot, SavedPosition } from '../components/reader/readerSource'

// --- module-boundary fakes ---------------------------------------------------------------------
const appState = vi.hoisted(() => {
  const listeners = new Set<(s: string) => void>()
  return {
    listeners,
    current: 'active',
    set(s: string) { appState.current = s; for (const l of [...listeners]) l(s) },
  }
})
vi.mock('react-native', () => ({
  AppState: {
    get currentState() { return appState.current },
    addEventListener: (_: string, fn: (s: string) => void) => {
      appState.listeners.add(fn)
      return { remove: () => appState.listeners.delete(fn) }
    },
  },
}))
const toast = vi.hoisted(() => ({ show: vi.fn((_o: { onPress?: () => void }) => 1), dismiss: vi.fn() }))
vi.mock('../context/ToastContext', () => ({ useToast: () => toast }))
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => ({ language: 'en' }) }))
vi.mock('./useOnline', () => ({ useOnline: () => true }))
vi.mock('../lib/api', () => ({ API_URL: 'https://api.test' }))
vi.mock('../lib/readerHtml', () => ({
  buildReaderHtml: (html: string, _t: unknown, slug: string) => `<doc ${slug}>${html}`,
  buildPdfViewerHtml: () => '<pdf>',
}))

// --- harness -----------------------------------------------------------------------------------
const CHAPTERS = [
  { slug: 'ch-1', title: 'One', wordCount: 1000 },
  { slug: 'ch-2', title: 'Two', wordCount: 1000 },
]
const STD_FONT = 'Literata'
const DYSLEXIC_FONT = 'OpenDyslexic'
const pos = (chapterSlug: string, quote: string) => ({ v: 1, chapterSlug, anchor: { quote } } as unknown as TextPosition)
const saved = (s: Partial<SavedPosition>): SavedPosition => ({ position: null, offset: null, percent: null, ...s })
const newerAt = (offset: number, chapterSlug = 'ch-1'): NewerPosition => ({ chapterSlug, saved: saved({ offset }), label: 'Two' })

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

type Props = { bookKey: string | null; chapterSlug: string; fontFamily: string; fontSize: number }
const noop = () => {}

function mountReader(initial: Partial<Props> = {}) {
  const injected: string[] = []
  const positionLoads: ReturnType<typeof deferred<SavedPosition>>[] = []
  const newerLoads: ReturnType<typeof deferred<NewerPosition | null>>[] = []
  const io = {
    injectJs: (js: string) => { injected.push(js) },
    persist: vi.fn((_s: ProgressSnapshot) => {}),
    loadPosition: vi.fn((_slug: string) => { const d = deferred<SavedPosition>(); positionLoads.push(d); return d.promise }),
    loadNewer: vi.fn((_slug: string, _o?: { latest?: boolean }) => { const d = deferred<NewerPosition | null>(); newerLoads.push(d); return d.promise }),
    session: vi.fn(),
    onPdfMessage: vi.fn((data: { type: string }) => data.type.startsWith('pdf')),
    onNavigateChapter: vi.fn(),
  }

  function useReader(p: Props) {
    const progressRef = useRef(0)
    const scrollOffsetRef = useRef(0)
    const currentChapterSlugRef = useRef<string | null>(null)
    const bookProgressRef = useRef<number | null>(null)
    const positionRef = useRef<TextPosition | null>(null)
    const totalWordCountRef = useRef(2000)
    const finishedChapterRef = useRef(false)
    const aliveRef = useRef(true)
    const sessionWordCountRef = useRef(0)
    const pdfInitialPageRef = useRef<number | null>(null)
    const currentPdfPageRef = useRef<number | null>(null)
    const pdfIsReloadRef = useRef(false)
    const pdfReadyRef = useRef(false)
    const pendingPdfColorRef = useRef('yellow')
    const highlightsRef = useRef([])
    const idx = CHAPTERS.findIndex(c => c.slug === p.chapterSlug)
    const chapter = {
      id: `id-${p.chapterSlug}`, title: CHAPTERS[idx].title, html: `<p>${p.chapterSlug}</p>`,
      prev: CHAPTERS[idx - 1] ?? null, next: CHAPTERS[idx + 1] ?? null,
    }

    const persistence = useReaderPersistence({
      bookKey: p.bookKey, chapterSlug: p.chapterSlug, chapterId: chapter.id, injectJs: io.injectJs,
      progressRef, scrollOffsetRef, currentChapterSlugRef, bookProgressRef, positionRef,
      persist: io.persist, loadPosition: io.loadPosition, loadNewerPosition: io.loadNewer,
    })
    const feed = useReaderSessionFeed({
      chapters: CHAPTERS, chapterSlug: p.chapterSlug, original: false,
      positionSettled: persistence.positionSettled, sessionJumpRef: persistence.sessionJumpRef,
      onRestoreLanded: persistence.onRestoreLanded, bumpProgress: persistence.bumpProgress,
      progressRef, scrollOffsetRef, positionRef, currentChapterSlugRef, bookProgressRef, totalWordCountRef,
      finishedChapterRef, updateSessionProgress: io.session, recordSessionActivity: noop,
    })
    const nav = useReaderChapterNav({
      chapter, chapters: CHAPTERS, bookTitle: 'Book', saveProgress: persistence.saveProgress,
      ensureChapter: async () => {}, isChapterOnDevice: async () => true,
      onNavigateChapter: io.onNavigateChapter, chapterNavigatorRef: persistence.chapterNavigatorRef,
      original: false, injectJs: io.injectJs, visitKey: 'book', handOffSession: () => ({ snapshot: null, flush: noop }) as never,
      sessionWordCount: 0, sessionWordCountRef, finishedChapterRef, aliveRef, showToast: toast.show as never,
      language: 'en', footerHeight: 0, discussBrief: null, discuss: noop, handleExitReview: noop,
      router: { dismissTo: noop } as never,
    })
    const onMessage = useReaderMessages({
      original: false, toggleBars: noop, showBars: noop, hideBars: noop, recordSessionActivity: noop,
      haptics: { play: noop } as never, onPositionMessage: feed.onMessage, onPdfMessage: io.onPdfMessage,
      onChapterEndActionRef: nav.onChapterEndActionRef, highlightsRef, setEditingHighlight: noop,
      openSelection: noop, createPdfHighlight: noop as never, pendingPdfColorRef,
    })
    const doc = useReaderDocument({
      original: false, originalFileUrl: null, originalInitialPage: null, htmlChapterSlug: p.chapterSlug,
      injectJs: io.injectJs, reflow: persistence.reflow, onDocumentRebuild: persistence.onDocumentRebuild,
      chapter, settings: { fontSize: p.fontSize, lineHeight: 1.6, textAlign: 'left' } as never,
      resolvedFontFamily: p.fontFamily, resolvedTheme: { backgroundColor: '#fff', textColor: '#000' } as never,
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
      pdfToken: null, pdfTokenReady: false, pdfReloadNonce: 0, isLocalOriginal: false,
      pdfInitialPageRef, currentPdfPageRef, pdfIsReloadRef, pdfReadyRef,
    })
    // ReaderShell's onLoadEnd, reflow branch — the persistence and typography half of it.
    const loadEnd = () => { persistence.onWebViewLoaded(); doc.docLoadedRef.current = true; doc.applyTypography(); doc.applyChrome() }
    return { loadEnd, onMessage, onRendererGone: doc.onRendererGone }
  }

  const props: Props = { bookKey: 'book', chapterSlug: 'ch-1', fontFamily: STD_FONT, fontSize: 18, ...initial }
  const h = renderHook(useReader, props)
  let unmounted = false
  const unmount = () => { if (!unmounted) { unmounted = true; h.unmount() } }
  mounted.push(unmount)

  /** Restore-carrying injections, in order: restores and typography reflows, with their ids. */
  const restores = () => injected.flatMap(js => {
    const m = js.match(/__textstack(RestoreAnchor|RestoreScroll|RestorePercent|ApplyTypography)\((.*), (\d+)\)$/)
    return m ? [{ kind: m[1], arg: m[2], id: Number(m[3]) }] : []
  })
  const send = (data: object) => act(() => h.result.current.onMessage({ nativeEvent: { data: JSON.stringify(data) } }))
  const progress = (scrollY: number, percent: number, position: TextPosition | null = null) =>
    send({ type: 'progress', progress: percent, scrollY, position, chapterSlug: props.chapterSlug })

  const web = {
    injected,
    restores,
    lastRestore: () => restores().at(-1),
    loadEnd: () => act(() => h.result.current.loadEnd()),
    send,
    progress,
    /** The WebView acks a restore, then (as readerHtml does) reports where it landed. */
    land(id: number, scrollY: number, percent = 0.3, position: TextPosition | null = null) {
      send({ type: 'restored', restoreId: id, scrollY })
      progress(scrollY, percent, position)
    },
    rendererGone: () => act(() => h.result.current.onRendererGone()),
  }
  return {
    io, web,
    rerender(next: Partial<Props>) { Object.assign(props, next); h.rerender(next) },
    unmount,
    answerPosition: (s: SavedPosition) => act(async () => { positionLoads.at(-1)!.resolve(s) }),
    answerNewer: (n: NewerPosition | null) => act(async () => { newerLoads.at(-1)!.resolve(n) }),
    tick: (ms: number) => act(() => { vi.advanceTimersByTime(ms) }),
  }
}

/** Open ch-1 with a saved offset of 900 and let the restore land there; the open's server check answers nothing. */
async function openLanded() {
  const r = mountReader()
  await r.answerPosition(saved({ offset: 900 }))
  await r.answerNewer(null)
  r.web.loadEnd()
  r.web.land(r.web.lastRestore()!.id, 900)
  return r
}

// Unmounted after each test, so no AppState listener or timer outlives it.
const mounted: (() => void)[] = []
beforeEach(() => {
  forgetChapterPositions()
  vi.useFakeTimers()
  appState.current = 'active'
  toast.show.mockClear()
  toast.dismiss.mockClear()
})
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  vi.useRealTimers()
})

// --- tests -------------------------------------------------------------------------------------

describe('C1 — the restore waits for both the document and the saved position', () => {
  it('position read first, document loaded second → restores at the load', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))
    expect(r.web.restores()).toEqual([])
    r.web.loadEnd()
    expect(r.web.restores()).toEqual([{ kind: 'RestoreScroll', arg: '900', id: 1 }])
  })

  it('document loaded first, position read second → restores when the position arrives, once', async () => {
    const r = mountReader()
    r.web.loadEnd()
    expect(r.web.restores()).toEqual([])
    await r.answerPosition(saved({ offset: 900 }))
    expect(r.web.restores()).toEqual([{ kind: 'RestoreScroll', arg: '900', id: 1 }])
    r.web.land(1, 900)
    // A later render (a font-size change) reflows; it does not fire the open restore again.
    r.rerender({ fontSize: 22 })
    expect(r.web.restores()).toEqual([
      { kind: 'RestoreScroll', arg: '900', id: 1 },
      { kind: 'ApplyTypography', arg: expect.stringContaining('22px'), id: 2 },
    ])
  })

  it('the book id resolving after the document loaded does not forget the load', async () => {
    const r = mountReader({ bookKey: null })
    r.web.loadEnd()
    expect(r.io.loadPosition).not.toHaveBeenCalled()
    r.rerender({ bookKey: 'book' })
    await r.answerPosition(saved({ offset: 900 }))
    // No second onLoadEnd follows a book id resolving for the same document.
    expect(r.web.lastRestore()).toEqual({ kind: 'RestoreScroll', arg: '900', id: 1 })
  })
})

describe('the write gate — nothing is saved before the restore lands', () => {
  it('not the load event, not a scroll-free wait, not going to the background', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))
    r.web.loadEnd()
    r.web.progress(0, 0)            // the document's load event: top of the chapter
    r.tick(3000)                    // under RESTORE_SETTLE_MS
    act(() => appState.set('background'))
    expect(r.io.persist).not.toHaveBeenCalled()

    act(() => appState.set('active'))
    r.web.land(r.web.lastRestore()!.id, 900)
    r.tick(2000)
    expect(r.io.persist).toHaveBeenCalledTimes(1)
    expect(r.io.persist.mock.calls[0][0]).toMatchObject({ chapterSlug: 'ch-1', scrollOffset: 900 })
  })

  it('a back press mid-restore writes nothing', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))
    r.web.loadEnd()
    r.web.progress(0, 0)
    r.unmount()
    expect(r.io.persist).not.toHaveBeenCalled()
  })

  it('nothing saved → the top is the restored position, and it can be saved', async () => {
    const r = mountReader()
    await r.answerPosition(saved({}))
    r.web.loadEnd()
    expect(r.web.restores()).toEqual([])
    r.web.progress(400, 0.1)
    r.tick(2000)
    expect(r.io.persist).toHaveBeenCalledTimes(1)
  })

  it('the landing report is the restore\'s jump, not reading; the next scroll is reading (M8)', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))
    r.web.loadEnd()
    r.web.progress(0, 0)
    expect(r.io.session).not.toHaveBeenCalled()
    r.web.land(r.web.lastRestore()!.id, 900, 0.3)
    expect(r.io.session).toHaveBeenLastCalledWith(0.15, { jump: true })
    r.web.progress(1200, 0.4)
    expect(r.io.session).toHaveBeenLastCalledWith(0.2, { jump: false })

    // A later restore (renderer remount): its travel is not fed, its landing is a jump again.
    const fed = r.io.session.mock.calls.length
    r.web.rendererGone()
    r.web.progress(0, 0)
    expect(r.io.session).toHaveBeenCalledTimes(fed)
    r.web.loadEnd()
    r.web.land(r.web.lastRestore()!.id, 1200, 0.4)
    expect(r.io.session).toHaveBeenLastCalledWith(0.2, { jump: true })
  })
})

describe('rebuilds and reflows keep the restore target (rule 8)', () => {
  it('a rebuild while the open restore is in flight restores the saved target, not the load-event top', async () => {
    const r = mountReader()
    const A = pos('ch-1', 'saved place')
    await r.answerPosition(saved({ position: A }))
    r.web.loadEnd()
    const first = r.web.lastRestore()!
    expect(first.kind).toBe('RestoreAnchor')

    r.rerender({ fontFamily: DYSLEXIC_FONT })                // new font face → rebuild
    r.web.progress(0, 0, pos('ch-1', 'chapter top'))         // the new document's load event
    r.web.send({ type: 'restored', restoreId: first.id, scrollY: 900 })  // the dead document's late ack
    r.tick(2000)
    expect(r.io.persist).not.toHaveBeenCalled()

    r.web.loadEnd()
    const second = r.web.lastRestore()!
    expect(second.id).toBeGreaterThan(first.id)
    expect(second.kind).toBe('RestoreAnchor')
    expect(second.arg).toContain('saved place')
    r.tick(2000)
    expect(r.io.persist).not.toHaveBeenCalled()
    r.web.land(second.id, 900, 0.3, A)
    r.tick(2000)
    expect(r.io.persist).toHaveBeenCalledTimes(1)
  })

  it('review #2: a second rebuild before the first one loads keeps rebuild #1\'s target', async () => {
    const r = await openLanded()
    r.web.progress(3000, 0.6, pos('ch-1', 'read on to B'))   // the reader reads on to B
    r.rerender({ fontFamily: DYSLEXIC_FONT })                // rebuild #1 snapshots B
    r.web.progress(0, 0, pos('ch-1', 'chapter top'))         // its document's load event
    r.web.rendererGone()                                      // rebuild #2, before #1 loaded
    r.web.loadEnd()
    const last = r.web.lastRestore()!
    expect(last.kind).toBe('RestoreAnchor')
    expect(last.arg).toContain('read on to B')
  })

  it('a reflow while the open restore is in flight re-asks the pending target after the typography', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))
    r.web.loadEnd()
    r.rerender({ fontSize: 22 })
    expect(r.web.restores().map(x => [x.kind, x.arg])).toEqual([
      ['RestoreScroll', '900'],
      ['ApplyTypography', expect.stringContaining('22px')],
      ['RestoreScroll', '900'],
    ])
    // The real bridge order (readerHtml.ts). onLoadEnd injects the restore and the typography in
    // one tick, so all three rAF callbacks run in the same frame, in injection order, and every
    // ackRestore posts `restored` then a forced `progress`:
    //   1. RestoreScroll(900, #1) → stale ack + landing report at 900. After a stale ack, position
    //      reports no longer stand in for #3's ack (readerWriteGate `staleAck`): the gate stays shut.
    //   2. ApplyTypography(#2) captured its anchor at injection time, before #1 scrolled: the
    //      chapter top. It scrolls back there → stale ack + report at 0, gate still shut.
    //   3. The re-ask RestoreScroll(900, #3) → ack + landing at 900. Only this opens the gate.
    const [first, typography, reask] = r.web.restores()
    r.web.land(first.id, 900)
    r.web.land(typography.id, 0, 0, pos('ch-1', 'chapter top'))
    r.web.land(reask.id, 900)
    r.tick(2000)
    expect(r.io.persist).toHaveBeenCalledTimes(1)
    expect(r.io.persist.mock.calls[0][0]).toMatchObject({ scrollOffset: 900 })
  })

  it('a flush between the reflow\'s top landing and the re-ask\'s landing writes nothing', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))
    r.web.loadEnd()
    r.rerender({ fontSize: 22 })
    const [first, typography] = r.web.restores()
    r.web.land(first.id, 900)
    r.web.land(typography.id, 0, 0, pos('ch-1', 'chapter top'))
    r.unmount()                                               // back press before #3 reports
    expect(r.io.persist).not.toHaveBeenCalled()
  })

  it('a lost ack still opens the gate by position', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))
    r.web.loadEnd()
    r.web.progress(900, 0.3)                                  // the landing report; its ack never came
    r.unmount()                                               // the flush sees an open gate
    expect(r.io.persist).toHaveBeenCalledTimes(1)
    expect(r.io.persist.mock.calls[0][0]).toMatchObject({ scrollOffset: 900 })
  })

  it('a lost re-ask ack after a stale one opens the gate at the deadline', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))
    r.web.loadEnd()
    r.rerender({ fontSize: 22 })
    const [first, typography] = r.web.restores()
    r.web.land(first.id, 900)
    r.web.land(typography.id, 0, 0, pos('ch-1', 'chapter top'))
    r.web.progress(900, 0.3)                                  // #3's landing report; its ack lost
    r.tick(3900)
    expect(r.io.persist).not.toHaveBeenCalled()
    r.tick(100)                                               // RESTORE_SETTLE_MS
    r.web.progress(950, 0.31)
    r.tick(2000)
    expect(r.io.persist).toHaveBeenCalledTimes(1)
    expect(r.io.persist.mock.calls[0][0]).toMatchObject({ scrollOffset: 950 })
  })

  it('review #1: a reflow\'s ack does not reset "has the reader moved" — a late server answer prompts', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))           // the open's server check is now in flight
    r.web.loadEnd()
    r.web.land(r.web.lastRestore()!.id, 900)
    r.web.progress(2000, 0.5)                                 // the reader reads on
    r.rerender({ fontSize: 22 })                              // reflow; acks where the reader is
    r.web.land(r.web.lastRestore()!.id, 2000, 0.5)
    await r.answerNewer(newerAt(5000))
    expect(toast.show).toHaveBeenCalledTimes(1)
    expect(r.web.restores().some(x => x.arg === '5000')).toBe(false)
  })
})

describe('a newer position on the server', () => {
  it('before the restore → adopted as the restore target, silently', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))
    await r.answerNewer(newerAt(5000))
    expect(r.web.restores()).toEqual([])
    r.web.loadEnd()
    expect(r.web.restores()).toEqual([{ kind: 'RestoreScroll', arg: '5000', id: 1 }])
    expect(toast.show).not.toHaveBeenCalled()
  })

  it('after the restore, reader has not moved → moves there silently', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))
    r.web.loadEnd()
    r.web.land(r.web.lastRestore()!.id, 900)
    r.web.progress(920, 0.3)                                  // jitter under the tolerance
    await r.answerNewer(newerAt(5000))
    expect(r.web.lastRestore()).toMatchObject({ kind: 'RestoreScroll', arg: '5000' })
    expect(toast.show).not.toHaveBeenCalled()
  })

  it('after the restore, reader has moved → asks; the action moves there', async () => {
    const r = mountReader()
    await r.answerPosition(saved({ offset: 900 }))
    r.web.loadEnd()
    r.web.land(r.web.lastRestore()!.id, 900)
    r.web.progress(2000, 0.5)
    await r.answerNewer(newerAt(5000))
    expect(r.web.restores().some(x => x.arg === '5000')).toBe(false)
    expect(toast.show).toHaveBeenCalledTimes(1)
    act(() => toast.show.mock.calls[0][0].onPress!())
    expect(r.web.lastRestore()).toMatchObject({ kind: 'RestoreScroll', arg: '5000' })
    r.unmount()
    expect(toast.dismiss).toHaveBeenCalledWith(1)            // the prompt does not outlive the reader (M1)
  })

  it('in another chapter (C2) → asks; the action opens it through the shell, writes nothing more, and the next mount lands there', async () => {
    const r = await openLanded()
    r.web.progress(1500, 0.5)
    act(() => appState.set('background'))
    act(() => appState.set('active'))
    await r.answerNewer(newerAt(5000, 'ch-2'))
    expect(toast.show).toHaveBeenCalledTimes(1)
    act(() => toast.show.mock.calls[0][0].onPress!())
    expect(r.io.onNavigateChapter).toHaveBeenCalledWith('ch-2')
    const writes = r.io.persist.mock.calls.length
    r.unmount()                                               // router.replace
    r.tick(5000)
    expect(r.io.persist).toHaveBeenCalledTimes(writes)       // nothing re-stamps ch-1 over the other device

    const next = mountReader({ chapterSlug: 'ch-2' })
    await next.answerPosition(saved({ offset: 100 }))        // the device's own (older) record
    next.web.loadEnd()
    expect(next.web.lastRestore()).toMatchObject({ kind: 'RestoreScroll', arg: '5000' })
    expect(next.io.loadNewer).not.toHaveBeenCalled()         // handed over: no second server check
  })
})

describe('back in the foreground (H3, R4 bug 3)', () => {
  it('during a rebuild: the check waits for the landing, then measures "moved" from the landing', async () => {
    const r = await openLanded()
    expect(r.io.loadNewer).toHaveBeenCalledTimes(1)          // the open's check
    act(() => appState.set('background'))
    r.web.rendererGone()                                      // the OS killed the renderer
    act(() => appState.set('active'))
    expect(r.io.loadNewer).toHaveBeenCalledTimes(1)          // deferred, not run against the zeros

    r.web.progress(0, 0)                                      // the remounted document's load event
    r.web.loadEnd()
    r.web.send({ type: 'restored', restoreId: r.web.lastRestore()!.id, scrollY: 900 })
    expect(r.io.loadNewer).toHaveBeenCalledTimes(2)
    expect(r.io.loadNewer).toHaveBeenLastCalledWith('ch-1', { latest: true })
    r.web.progress(900, 0.3)
    await r.answerNewer(newerAt(5000))
    expect(r.web.lastRestore()).toMatchObject({ kind: 'RestoreScroll', arg: '5000' })
    expect(toast.show).not.toHaveBeenCalled()
  })

  it('landed long ago: checks at once, against where the reader is now', async () => {
    const r = await openLanded()
    r.web.progress(2000, 0.5)
    act(() => appState.set('background'))
    act(() => appState.set('active'))
    expect(r.io.loadNewer).toHaveBeenLastCalledWith('ch-1', { latest: true })
    await r.answerNewer(newerAt(5000))
    expect(r.web.lastRestore()).toMatchObject({ kind: 'RestoreScroll', arg: '5000' })
  })
})

describe('chapter change', () => {
  it('Next in the chapter-end block saves the old chapter at its place before navigating', async () => {
    const r = await openLanded()
    r.web.progress(1500, 0.5)                                 // debounced save armed, not yet fired
    expect(r.io.persist).not.toHaveBeenCalled()
    let savedBeforeNavigate: ProgressSnapshot[] = []
    r.io.onNavigateChapter.mockImplementation(() => { savedBeforeNavigate = r.io.persist.mock.calls.map(c => c[0]) })
    await act(async () => r.web.send({ type: 'chapterEnd', action: 'next' }))
    expect(r.io.onNavigateChapter).toHaveBeenCalledWith('ch-2')
    expect(savedBeforeNavigate).toEqual([expect.objectContaining({ chapterSlug: 'ch-1', scrollOffset: 1500, chapterPercent: 0.5 })])
    r.unmount()                                               // router.replace remounts the screen
    r.tick(5000)
    for (const [snap] of r.io.persist.mock.calls) expect(snap).toMatchObject({ chapterSlug: 'ch-1', scrollOffset: 1500 })
  })

  it('Next, read on, Prev → back where the chapter was left, though the device keeps one record per book', async () => {
    // Both sources' device record (progressStorage) is ONE row per book: it names the last chapter
    // saved, and loadPosition answers only for that chapter.
    let record: ProgressSnapshot | null = null
    const fromRecord = (slug: string) => record?.chapterSlug === slug
      ? saved({ offset: record.scrollOffset, position: record.position })
      : saved({})
    const a = await openLanded()                              // ch-1 at 900
    a.io.persist.mockImplementation(s => { record = s })
    a.web.progress(1500, 0.5)
    await act(async () => a.web.send({ type: 'chapterEnd', action: 'next' }))
    a.unmount()

    const b = mountReader({ chapterSlug: 'ch-2' })
    b.io.persist.mockImplementation(s => { record = s })
    await b.answerPosition(fromRecord('ch-2'))
    await b.answerNewer(null)
    b.web.loadEnd()
    b.web.progress(300, 0.1)                                  // a little reading in ch-2, then wait
    b.tick(6000)
    expect(record).toMatchObject({ chapterSlug: 'ch-2', scrollOffset: 300 })
    await act(async () => b.web.send({ type: 'chapterEnd', action: 'prev' }))
    expect(b.io.onNavigateChapter).toHaveBeenCalledWith('ch-1')
    b.unmount()

    const c = mountReader({ chapterSlug: 'ch-1' })
    await c.answerPosition(fromRecord('ch-1'))                // nothing: the record names ch-2
    c.web.loadEnd()
    expect(c.web.lastRestore()).toMatchObject({ kind: 'RestoreScroll', arg: '1500' })
  })

  it('a chapter left in another book is never recalled', async () => {
    const a = await openLanded()
    a.web.progress(1500, 0.5)
    await act(async () => a.web.send({ type: 'chapterEnd', action: 'next' }))
    a.unmount()
    const c = mountReader({ bookKey: 'other', chapterSlug: 'ch-1' })
    await c.answerPosition(saved({}))
    c.web.loadEnd()
    expect(c.web.restores()).toEqual([])
  })
})

describe('bridge routing', () => {
  it('pdf* messages go to the PDF owner and never touch the reflow position', async () => {
    const r = await openLanded()
    r.web.send({ type: 'pdfPage', page: 7, numPages: 40 })
    expect(r.io.onPdfMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'pdfPage' }))
    r.tick(2000)
    expect(r.io.persist).toHaveBeenCalledTimes(1)             // only the landing's save
  })
})
