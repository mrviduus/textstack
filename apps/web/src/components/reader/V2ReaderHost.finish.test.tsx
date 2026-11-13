import { ApiError, type V2ReadingState, type V2ReadingStateWrite } from '@textstack/shared'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { v2ReaderSyncApi, type V2SyncTarget } from '../../lib/v2ReaderSync'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'

// #1266 in the host, on the real session (the server faked): the end-of-book block follows the page's `atEnd`,
// "Finish book" writes the completion through the host, a failure is said with a retry, a finished book says so.

const SHA = 'a'.repeat(64)
const T: V2SyncTarget = { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: SHA, size: 8, name: 'b1.epub' }
const cfi = (n: number) => `epubcfi(/6/${2 * n + 2}!/4/2/1:0)`
const AT = '2026-01-01T00:00:00.000Z'
const state = (revision: number, extra: Partial<V2ReadingState> = {}): V2ReadingState => ({
  bookId: T.bookId, fileId: T.fileId, currentLocator: { version: 1, scheme: 'epub-cfi', value: cfi(9), quote: 'quote 9' },
  bookFraction: 0.97, frontierLocator: null, frontierFraction: null, completedAt: null, clientRecordedAt: AT, updatedAt: AT, revision, resetRevision: null, ...extra,
})

afterEach(() => vi.restoreAllMocks())

/** The host with a synced book opened and restored; `put` is the reading-state write. */
async function reader(o: { target?: V2SyncTarget; server?: V2ReadingState | null; dev?: boolean } = {}) {
  const target = o.target ?? T
  let server = o.server === undefined ? state(4) : o.server
  vi.spyOn(v2ReaderSyncApi, 'getReadingState').mockImplementation(async () => server)
  vi.spyOn(v2ReaderSyncApi, 'annotations').mockResolvedValue([])
  const put = vi.spyOn(v2ReaderSyncApi, 'putReadingState').mockImplementation(async (_b, w: V2ReadingStateWrite) =>
    (server = { ...state((w.expectedRevision ?? 0) + 1), currentLocator: w.currentLocator, bookFraction: w.bookFraction, clientRecordedAt: w.clientRecordedAt, completedAt: w.completedAt ?? null }))
  const host = (book: V2HostBook | null) => <MemoryRouter><V2ReaderHost book={book} dev={o.dev} /></MemoryRouter>
  const view = render(host(null))
  const frame = (screen.getByTitle('V2 reader') as HTMLIFrameElement).contentWindow!
  vi.spyOn(frame, 'postMessage').mockImplementation((() => {}) as never)
  const fromPage = (m: object) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame }))
    await new Promise((r) => setTimeout(r, 0))
  })
  let opens = 0
  /** A new book handed to the host; `answer()` is the page's `opened` + `restored` for it. */
  const pick = (t: V2SyncTarget = target) => {
    view.rerender(host({ bytes: new ArrayBuffer(8), name: t.name, sync: o.dev ? undefined : t }))
    const name = `${++opens}/${t.name}`
    return async () => {
      await fromPage({ type: 'opened', title: 'T', format: t.format, book: { sha256: t.sha256, size: 8, name } })
      await fromPage({ type: 'restored', key: t.sha256, position: 'restored' })
    }
  }
  const openBook = (t?: V2SyncTarget) => pick(t)()
  await fromPage({ type: 'ready' })
  await openBook()
  const relocate = (m: object) => fromPage({ type: 'relocate', cfi: cfi(9), index: 9, sections: 10, fraction: 0.97, ...m })
  const click = (name: string) => act(async () => {
    screen.getByRole('button', { name }).click()
    await new Promise((r) => setTimeout(r, 0))
  })
  return { put, relocate, click, openBook, pick, fromPage }
}
const block = () => screen.queryByTestId('v2-finish')

describe('V2ReaderHost finish book (#1266)', () => {
  it('relocate_AtEndThenAway_BlockShownThenHidden', async () => {
    const { relocate } = await reader()
    expect(block()).toBeNull()
    // The fraction alone never shows it (scrolled flow reports the top of the screen).
    await relocate({ fraction: 1 })
    expect(block()).toBeNull()
    await relocate({ atEnd: true })
    expect(screen.getByRole('button', { name: 'Finish book' })).toBeEnabled()
    await relocate({ atEnd: false, fraction: 0.5 })
    expect(block()).toBeNull()
  })

  it('finish_Clicked_CompletionWrittenOnTheServerWithTheRealFractionAndTheBookSaysFinished', async () => {
    const { put, relocate, click } = await reader()
    await relocate({ atEnd: true })
    await click('Finish book')
    expect(put.mock.calls.map((c) => c[1])).toEqual([expect.objectContaining({ expectedRevision: 4, bookFraction: 0.97, completedAt: expect.any(String), clientRecordedAt: AT })])
    expect(screen.getByTestId('v2-finished')).toHaveTextContent('You finished this book.')
    expect(block()).toBeNull()
  })

  it('finish_TwoClicksAtOnce_OneWrite', async () => {
    const { put, relocate } = await reader()
    await relocate({ atEnd: true })
    await act(async () => {
      const b = screen.getByRole('button', { name: 'Finish book' })
      b.click()
      b.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(put).toHaveBeenCalledTimes(1)
  })

  it('finish_Offline_ErrorSaidThenRetryLands', async () => {
    const { put, relocate, click } = await reader()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    put.mockRejectedValueOnce(new ApiError(0, 'offline'))
    await relocate({ atEnd: true })
    await click('Finish book')
    expect(screen.getByRole('alert')).toHaveTextContent('Could not mark the book as finished')
    expect(screen.queryByTestId('v2-finished')).toBeNull()
    await click('Retry')
    expect(put).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('v2-finished')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('open_BookAlreadyFinished_SaysFinishedAtItsEndAndOffersNoButton', async () => {
    const { put, relocate } = await reader({ server: state(4, { completedAt: '2026-11-01T00:00:00.000Z' }) })
    expect(screen.queryByTestId('v2-finished')).toBeNull()
    await relocate({ atEnd: true })
    expect(screen.getByTestId('v2-finished')).toBeInTheDocument()
    expect(block()).toBeNull()
    expect(put).not.toHaveBeenCalled()
  })

  it('cbz_AtEnd_NoBlock', async () => {
    const { relocate } = await reader({ target: { ...T, format: 'cbz' }, server: null })
    await relocate({ atEnd: true })
    expect(block()).toBeNull()
  })

  it('devRoute_NoServerBook_NoBlock', async () => {
    const { relocate } = await reader({ dev: true })
    await relocate({ atEnd: true })
    expect(block()).toBeNull()
  })

  it('newOpen_ThePreviousBooksLateRelocateAndThisBooksStateNotReadYet_NoBlock', async () => {
    const { relocate, pick } = await reader()
    await relocate({ atEnd: true })
    const answer = pick({ ...T, name: 'next.epub' })
    // The old book may still relocate until the page takes up the new open: its end is not the new book's.
    await relocate({ atEnd: true })
    let read!: (s: V2ReadingState | null) => void
    vi.mocked(v2ReaderSyncApi.getReadingState).mockImplementationOnce(() => new Promise((ok) => { read = ok }))
    await answer()
    expect(block()).toBeNull()
    // This book's own end, its reading state still being read: no block from the previous book's state.
    await relocate({ atEnd: true })
    expect(block()).toBeNull()
    await act(async () => {
      read(state(1))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(block()).not.toBeNull()
  })

  it('newOpen_AfterTheEndOfAnotherBook_BlockGoneUntilThisBooksOwnEnd', async () => {
    const { relocate, openBook } = await reader()
    await relocate({ atEnd: true })
    expect(block()).not.toBeNull()
    await openBook({ ...T, name: 'again.epub' })
    expect(block()).toBeNull()
    await relocate({ atEnd: true })
    expect(block()).not.toBeNull()
  })
})
