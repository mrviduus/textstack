import type { PendingSession } from '@textstack/shared'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { readerSyncApi, type SyncTarget } from '../../lib/readerSync'
import { ReaderHost, type HostBook } from './ReaderHost'

// #1313 in the host: a synced book's reading session goes to the session queue (useReadingSession's, which sends
// it to PUT /me/v2/reading/sessions/{id}); the session rules themselves are sessionTracker.test.ts's.

const queued: PendingSession[] = []
vi.mock('../../hooks/useReadingSession', () => ({
  queueReadingSession: (s: PendingSession) => queued.push(s),
  flushPendingSessions: async () => {},
}))

const track = vi.fn()
vi.mock('../../lib/analytics', async (original) => ({
  ...(await original<typeof import('../../lib/analytics')>()),
  trackReadingSessionEnd: (a: unknown) => track(a),
}))
let signedIn = true
vi.mock('../../context/AuthContext', async (original) => ({
  ...(await original<typeof import('../../context/AuthContext')>()),
  useAuth: () => ({ isAuthenticated: signedIn }),
}))

const target = (n: number): SyncTarget => ({ bookId: `b${n}`, fileId: `f${n}`, format: 'epub', sha256: String(n).repeat(64), size: 8, name: `b${n}.epub` })
let now = Date.parse('2026-11-14T10:00:00Z')
const later = (s: number) => { now += s * 1000 }

beforeEach(() => {
  queued.length = 0
  now = Date.parse('2026-11-14T10:00:00Z')
  track.mockClear()
  signedIn = true
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.spyOn(readerSyncApi, 'getReadingState').mockResolvedValue(null)
  vi.spyOn(readerSyncApi, 'annotations').mockResolvedValue([])
})
afterEach(() => vi.restoreAllMocks())

async function reader(o: { dev?: boolean } = {}) {
  const host = (book: HostBook | null) => <MemoryRouter><ReaderHost book={book} dev={o.dev} /></MemoryRouter>
  const view = render(host(null))
  const frame = (screen.getByTitle('Book text') as HTMLIFrameElement).contentWindow!
  vi.spyOn(frame, 'postMessage').mockImplementation((() => {}) as never)
  const fromPage = (m: object) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame }))
    await new Promise((r) => setTimeout(r, 0))
  })
  let opens = 0
  /** A book handed to the host; the page has not answered. */
  const ask = async (t: SyncTarget) => { view.rerender(host({ bytes: new ArrayBuffer(8), name: t.name, sync: o.dev ? undefined : t })) }
  /** A book handed to the host and opened by the page (its bytes `sha256`), landing at 10 %. */
  const open = async (t: SyncTarget, sha256 = t.sha256) => {
    await ask(t)
    await fromPage({ type: 'opened', title: 'T', format: 'epub', toc: [{ label: 'One', href: 'c1.xhtml', depth: 0 }, { label: 'Two', href: 'c2.xhtml', depth: 0 }], book: { sha256, size: 8, name: `${++opens}/${t.name}` } })
    await relocate(0.1, false, 'nav')
  }
  /** A relocate as the page sends it; `cause` (#1313): a reader's turn unless said otherwise. */
  const relocate = (fraction: number, moved = true, cause = 'turn') => fromPage({ type: 'relocate', cfi: 'epubcfi(/6/2!/4/2)', index: 1, sections: 3, fraction, moved, words: 100_000, tocIndex: 0, cause })
  await fromPage({ type: 'ready' })
  return { ask, open, relocate, fromPage, unmount: view.unmount }
}

describe('ReaderHost reading sessions (#1313)', () => {
  it('unmount_AfterReading_SessionQueuedForTheServerBookUnderItsOwnId', async () => {
    const r = await reader()
    await r.open(target(1))
    later(60)
    await r.relocate(0.1005) // the first turn starts the session
    later(60)
    await r.relocate(0.1015) // 100 words
    later(30)
    r.unmount()
    expect(queued).toEqual([{
      userBookId: 'b1', clientSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/), startedAt: '2026-11-14T10:01:00.000Z', endedAt: '2026-11-14T10:02:30.000Z',
      durationSeconds: 90, wordsRead: 100, startPercent: 0.1, endPercent: 0.1015,
    }])
  })

  it('open_AnotherBook_TheFirstBooksSessionEndsThere', async () => {
    const r = await reader()
    await r.open(target(1))
    await r.relocate(0.2)
    later(20)
    await r.open(target(2))
    later(5)
    await r.relocate(0.3)
    later(15)
    r.unmount()
    expect(queued.map((s) => [s.userBookId, s.durationSeconds])).toEqual([['b1', 20], ['b2', 15]])
  })

  it('open_AnotherBookThatFails_TheSessionEndsAtTheAsk', async () => {
    const r = await reader()
    await r.open(target(1))
    await r.relocate(0.2)
    later(20)
    await r.ask(target(2))
    await r.fromPage({ type: 'open-failed', name: '2/b2.epub', error: 'bad file' })
    later(100)
    r.unmount()
    expect(queued.map((s) => [s.userBookId, s.durationSeconds])).toEqual([['b1', 20]])
  })

  it('sectionControl_AfterTwoHours_ItsLandingCountsNoWordsTheNextTurnDoes', async () => {
    const r = await reader()
    await r.open(target(1))
    await r.relocate(0.1001) // starts the session
    later(60)
    await r.relocate(0.101) // 90 words
    later(7200)
    await act(async () => { fireEvent.click(screen.getByTestId('v2-next-section')) })
    later(2)
    await r.relocate(0.301, true, 'nav') // the landing, 2 s later, 20 % on
    later(60)
    await r.relocate(0.302) // 100 words
    r.unmount()
    expect(queued.map((s) => s.wordsRead)).toEqual([190])
  })

  it('nextButton_BarTurn_ItsPageCounts', async () => {
    const r = await reader()
    await r.open(target(1))
    await r.relocate(0.1001) // starts the session
    later(60)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Next ›' })) })
    await r.relocate(0.1011) // the turn the button made: 100 words
    r.unmount()
    expect(queued.map((s) => s.wordsRead)).toEqual([100])
  })

  it('unmount_SignedInOrNot_Ga4SessionEndForASignedInReaderOnlyWithoutIds', async () => {
    const r = await reader()
    await r.open(target(1))
    await r.relocate(0.2)
    later(30)
    r.unmount()
    expect(track.mock.calls).toEqual([[{ durationSeconds: 30, wordsRead: 0, startPercent: 0.1, endPercent: 0.2, editionId: null, userBookId: null }]])
    signedIn = false
    const s = await reader()
    await s.open(target(2))
    await s.relocate(0.2)
    later(30)
    s.unmount()
    expect(track).toHaveBeenCalledTimes(1)
    expect(queued.map((q) => q.userBookId)).toEqual(['b1', 'b2'])
  })

  it('tapOrKey_Malformed_NoActivity', async () => {
    const r = await reader()
    await r.open(target(1))
    await r.fromPage({ type: 'tap' })
    later(30)
    await r.fromPage({ type: 'key' })
    later(30)
    await r.relocate(0.2) // the first real activity
    later(30)
    r.unmount()
    expect(queued.map((q) => [q.startedAt, q.durationSeconds])).toEqual([['2026-11-14T10:01:00.000Z', 30]])
  })

  it('visibilityChange_Hidden_SessionEnded', async () => {
    const r = await reader()
    await r.open(target(1))
    await r.relocate(0.2)
    later(40)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(queued.map((s) => [s.userBookId, s.durationSeconds])).toEqual([['b1', 40]])
    r.unmount()
    expect(queued).toHaveLength(1)
  })

  it('open_DevRouteOrBytesNotTheServerFile_NoSession', async () => {
    const dev = await reader({ dev: true })
    await dev.open(target(1))
    await dev.relocate(0.2)
    later(60)
    dev.unmount()
    const other = await reader()
    await other.open(target(2), 'f'.repeat(64))
    await other.relocate(0.2)
    later(60)
    other.unmount()
    expect(queued).toEqual([])
  })
})
