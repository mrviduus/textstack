import type { PagePosition } from '@textstack/shared'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { V2SaveStatus, V2SyncTarget } from '../../lib/v2ReaderSync'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'

// #1226: the production route's host wiring to its server sync (lib/v2ReaderSync.ts, faked here): restore waits
// for the server, a superseded open's answer is dropped, `store` goes to the server and never to localStorage.

interface FakeSync {
  target: V2SyncTarget
  onStatus(s: V2SaveStatus): void
  onHighlights(list: unknown[]): void
  highlights?: boolean
  onNewerPlace(p: PagePosition): void
  /** The next `restore` call's answer (a new one per call: Retry calls it again). */
  answer(json: string | null): void
  fail(): void
  restore: ReturnType<typeof vi.fn>
  loadHighlights: ReturnType<typeof vi.fn>
  store: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  flushKeepalive: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}
const sessions: FakeSync[] = []
vi.mock('../../lib/v2ReaderSync', () => ({
  createV2ReaderSync: (target: V2SyncTarget, o: Pick<FakeSync, 'onStatus' | 'onHighlights' | 'highlights' | 'onNewerPlace'>) => {
    let settle: { ok(json: string | null): void; no(e: unknown): void } | null = null
    const closed = Promise.resolve()
    const s: FakeSync = {
      target, onStatus: o.onStatus, onHighlights: o.onHighlights, highlights: o.highlights, onNewerPlace: o.onNewerPlace,
      answer: (json) => settle?.ok(json), fail: () => settle?.no(new Error('offline')),
      restore: vi.fn(() => new Promise((ok, no) => { settle = { ok, no } })), loadHighlights: vi.fn(async () => {}),
      store: vi.fn(), flush: vi.fn(async () => {}), flushKeepalive: vi.fn(), close: vi.fn(() => closed),
    }
    sessions.push(s)
    return s
  },
}))

const frameWindow = () => (screen.getByTitle('V2 reader') as HTMLIFrameElement).contentWindow!
let posted: { call: string; args: unknown[] }[]

beforeEach(() => {
  localStorage.clear()
  posted = []
  sessions.length = 0
})

function mount() {
  const el = (b: V2HostBook | null) => <V2ReaderHost book={b} />
  const view = render(el(null))
  vi.spyOn(frameWindow(), 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  return { ...view, open: (b: V2HostBook) => view.rerender(el(b)) }
}
function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frameWindow() })) })
}
const SHA = (c: string) => c.repeat(64)
const target = (bookId: string, sha256: string): V2SyncTarget => ({ bookId, fileId: `f-${bookId}`, format: 'epub', sha256, size: 8, name: `${bookId}.epub` })
const synced = (bookId: string, sha256: string): V2HostBook => ({ bytes: new ArrayBuffer(8), name: `${bookId}.epub`, sync: target(bookId, sha256) })
const opened = (name: string, sha256: string) => ({ type: 'opened', title: 'T', book: { sha256, size: 8, name } })
const restores = () => posted.filter((m) => m.call === 'restore').map((m) => m.args[0])
const flushAll = () => act(async () => { await Promise.resolve() })

describe('V2ReaderHost, server sync', () => {
  it('opened_RestoreWaitsForTheServer_ThenItsEntry', async () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    expect(sessions.map((s) => s.target.bookId)).toEqual(['b1'])
    expect(restores()).toEqual([])
    sessions[0].answer('{"v":1}')
    await flushAll()
    expect(restores()).toEqual(['{"v":1}'])
  })

  it('aLaterTake_TheEarlierRestoreAnswerDropped_AndItsSessionClosed', async () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    open(synced('b2', SHA('b')))
    fromPage(opened('2/b2.epub', SHA('b')))
    expect(sessions[0].close).toHaveBeenCalled()
    sessions[0].answer('{"stale":1}')
    sessions[1].answer('{"fresh":1}')
    await flushAll()
    expect(restores()).toEqual(['{"fresh":1}'])
  })

  it('store_ToTheSession_ForItsBookOnly_NeverLocalStorage', () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    fromPage({ type: 'store', key: SHA('a'), json: '{"x":1}' })
    fromPage({ type: 'store', key: SHA('c'), json: '{"y":1}' })
    expect(sessions[0].store.mock.calls).toEqual([['{"x":1}']])
    expect(localStorage.length).toBe(0)
  })

  it('openedBytesAreNotTheServerFile_RestoreNull_NotSaved_NothingStored', () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('d')))
    expect(sessions).toEqual([])
    expect(restores()).toEqual([null])
    expect(screen.getByTestId('v2-not-saved')).toBeInTheDocument()
    fromPage({ type: 'store', key: SHA('d'), json: '{"x":1}' })
    expect(localStorage.length).toBe(0)
  })

  it('unsavedStatus_Shown_SavedClearsIt', () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    expect(screen.queryByTestId('v2-not-saved')).toBeNull()
    act(() => sessions[0].onStatus('unsaved'))
    expect(screen.getByTestId('v2-not-saved')).toHaveTextContent('Not saved')
    act(() => sessions[0].onStatus('saved'))
    expect(screen.queryByTestId('v2-not-saved')).toBeNull()
  })

  it('tabHidden_Flush_PageHide_KeepaliveFlush_Unmount_Closes', () => {
    const { open, unmount } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockRestore()
    window.dispatchEvent(new Event('pagehide'))
    expect(sessions[0].flush).toHaveBeenCalledTimes(1)
    expect(sessions[0].flushKeepalive).toHaveBeenCalledTimes(1)
    unmount()
    expect(sessions[0].close).toHaveBeenCalled()
  })

  // #1286: the page's latest `store`, taken synchronously from the frame (its `flush()`) on pagehide and unmount.
  describe('the last turn', () => {
    const LAST = '{"last":1}'
    function reading(flush: () => unknown) {
      const view = mount()
      fromPage({ type: 'ready' })
      view.open(synced('b1', SHA('a')))
      fromPage(opened('1/b1.epub', SHA('a')))
      const fol = vi.fn(flush);
      (frameWindow() as unknown as { __fol: unknown }).__fol = { flush: fol }
      return { ...view, fol }
    }

    it('pageHide_ThePagesLastStoreGoesIntoTheKeepaliveFlush', () => {
      const { fol } = reading(() => ({ type: 'store', key: SHA('a'), json: LAST }))
      window.dispatchEvent(new Event('pagehide'))
      expect(fol).toHaveBeenCalledTimes(1)
      expect(sessions[0].flushKeepalive.mock.calls).toEqual([[LAST]])
    })

    it('unmount_TakenWhileTheFrameIsStillThere_IntoClose', () => {
      let attached: boolean | null = null
      const { unmount } = reading(() => {
        attached = !!(screen.queryByTitle('V2 reader') as HTMLIFrameElement | null)?.isConnected
        return { type: 'store', key: SHA('a'), json: LAST }
      })
      unmount()
      expect(attached).toBe(true)
      expect(sessions[0].close.mock.calls[0]).toEqual([LAST])
    })

    it.each([
      ['another book', () => ({ type: 'store', key: SHA('c'), json: LAST })],
      ['not a store', () => ({ type: 'relocate', key: SHA('a'), json: LAST })],
      ['a json that is not a string', () => ({ type: 'store', key: SHA('a'), json: { last: 1 } })],
      ['nothing yet', () => null],
      ['a throw', () => { throw new Error('gone') }],
      ['a throwing getter', () => ({ type: 'store', key: SHA('a'), get json(): string { throw new Error('trap') } })],
      ['a Proxy whose fields change per read', () => {
        let n = 0
        return new Proxy({}, { get: (_t, k) => (k === 'json' ? (n++ ? LAST : 1) : k === 'type' ? 'store' : SHA('a')) })
      }],
    ])('%s_NothingTaken_TodaysFlushNoThrow', (_what, flush) => {
      const { unmount } = reading(flush)
      expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow()
      expect(sessions[0].flushKeepalive.mock.calls).toEqual([[undefined]])
      unmount()
      expect(sessions[0].close.mock.calls[0]).toEqual([undefined])
    })

    it('noPageInTheFrame_TodaysFlush', () => {
      const view = mount()
      fromPage({ type: 'ready' })
      view.open(synced('b1', SHA('a')))
      fromPage(opened('1/b1.epub', SHA('a')))
      window.dispatchEvent(new Event('pagehide'))
      expect(sessions[0].flushKeepalive.mock.calls).toEqual([[undefined]])
    })
  })

  it('highlights_PulledAfterTheRestore_DrawnAndHighlightingOfferedOnlyThen', async () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    sessions[0].answer('{"v":1}')
    await flushAll()
    expect(sessions[0].loadHighlights).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Highlight' })).toBeNull()
    act(() => sessions[0].onHighlights([{ id: 'h' }]))
    expect(posted.filter((m) => m.call === 'restore' || m.call === 'addHighlights').map((m) => m.call)).toEqual(['restore', 'addHighlights'])
    expect(posted[posted.length - 1].args).toEqual([[{ id: 'h' }]])
    expect(screen.getByRole('button', { name: 'Highlight' })).toBeInTheDocument()
  })

  it('readFails_NoRestore_AnAlertWithRetry_RetryRestores', async () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    sessions[0].fail()
    await flushAll()
    expect(restores()).toEqual([])
    expect(screen.getByTestId('v2-read-failed')).toBeInTheDocument()
    act(() => screen.getByRole('button', { name: 'Retry' }).click())
    expect(sessions[0].restore).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('v2-read-failed')).toBeNull()
    sessions[0].answer('{"v":2}')
    await flushAll()
    expect(restores()).toEqual(['{"v":2}'])
  })

  it('nextOpen_ClosesThePreviousSession_HighlightsOnlyWhereThePageOffersThem', () => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    expect(sessions[0].highlights).toBe(true)
    open(synced('b2', SHA('b')))
    fromPage({ ...opened('2/b2.epub', SHA('b')), annotatable: false })
    expect(sessions[0].close).toHaveBeenCalled()
    expect(sessions[1].highlights).toBe(false)
  })

  it('addHighlightsAnswer_NotDrawnOnesLogged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount()
    fromPage({ type: 'highlights', key: SHA('a'), highlights: [{ id: 'h1', status: 'restored' }, { id: 'h2', status: 'quote mismatch, not drawn' }] })
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(['[v2] highlight h2 not drawn: quote mismatch, not drawn'])
    warn.mockRestore()
  })

  it.each([['reopen', 'reopen it'], ['noHighlights', 'Highlights are not loaded'], ['unsaved', 'Not saved']] as const)('status %s_ItsOwnMessage', (st, text) => {
    const { open } = mount()
    fromPage({ type: 'ready' })
    open(synced('b1', SHA('a')))
    fromPage(opened('1/b1.epub', SHA('a')))
    act(() => sessions[0].onStatus(st))
    expect(screen.getByTestId('v2-not-saved')).toHaveTextContent(text)
  })

  // #1232: another device's newer place (the session decides by ADR-019; the host moves the page or asks).
  describe('newer place', () => {
    const THEIRS = { cfi: 'epubcfi(/6/10!/4/2/1:0)', quote: 'q', index: 4, fraction: 0.42, at: 1 }
    const goTos = () => posted.filter((m) => m.call === 'goTo').map((m) => m.args)
    function reading() {
      const { open } = mount()
      fromPage({ type: 'ready' })
      open(synced('b1', SHA('a')))
      fromPage(opened('1/b1.epub', SHA('a')))
      return sessions[0]
    }
    const bar = () => screen.queryByRole('status', { name: 'Newer reading place' })

    it('offered_ABarWithTwoButtons_GoMovesThePageThereAsTheReadersChoice', () => {
      const s = reading()
      act(() => s.onNewerPlace(THEIRS))
      expect(bar()).toHaveTextContent('Another device saved a newer place in this book (42%).')
      expect(goTos()).toEqual([])
      fireEvent.click(screen.getByRole('button', { name: 'Go to their place' }))
      // Chosen: the page saves where it lands.
      expect(goTos()).toEqual([[THEIRS, true]])
      expect(bar()).toBeNull()
    })

    it('offered_Stay_TheBarGoes_NothingElse', () => {
      const s = reading()
      act(() => s.onNewerPlace(THEIRS))
      const before = posted.length
      fireEvent.click(screen.getByRole('button', { name: 'Stay here' }))
      expect(posted.length).toBe(before)
      expect(bar()).toBeNull()
    })

    it('offeredAgain_TheNewestShown_KeptAcrossPageTurns', () => {
      const s = reading()
      act(() => s.onNewerPlace(THEIRS))
      act(() => s.onNewerPlace({ ...THEIRS, fraction: 0.6 }))
      fromPage({ type: 'relocate', cfi: 'c9', index: 9 })
      expect(bar()).toHaveTextContent('(60%)')
    })

    it('aNewBookOpening_TheBarGoesAtOnce', () => {
      const { open } = mount()
      fromPage({ type: 'ready' })
      open(synced('b1', SHA('a')))
      fromPage(opened('1/b1.epub', SHA('a')))
      act(() => sessions[0].onNewerPlace(THEIRS))
      open(synced('b2', SHA('b')))
      // Gone while b2 is still opening, before its `opened`.
      expect(bar()).toBeNull()
    })
  })
})
