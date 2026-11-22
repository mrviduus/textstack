import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Suspense } from 'react'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ApiError } from '@textstack/shared'

// #1225, M5 #1031: /:lang/library/my/:id/read[/:chapterSlug] and /read-v2 — gated on the V2 probe, the current file's bytes into the host.
const syncSwitch = vi.fn()
const liveBook = vi.fn()
const fetchFileBytes = vi.fn()
const pullBooks = vi.fn()
const syncAnswer = vi.fn()
vi.mock('../../api/sync', () => ({
  syncAnswer: () => syncAnswer(),
  pullBooks: () => pullBooks(),
  syncSwitch: () => syncSwitch(),
  liveBook: (id: string) => liveBook(id),
  fetchFileBytes: (...args: unknown[]) => fetchFileBytes(...args),
}))
const hostProps = vi.fn()
vi.mock('../../components/reader/ReaderHost', () => ({
  ReaderHost: (p: { book: unknown; children?: React.ReactNode }) => { hostProps(p); return <div data-testid="host">{p.children}</div> },
}))
vi.mock('../../components/SeoHead', () => ({ SeoHead: () => null }))

import { STALL_GRACE_MS, ReaderPage } from '../ReaderPage'
import { DOWNLOAD_STALL_MS } from '../../../../../packages/reader/src/deadlines.mjs'

const BYTES = new ArrayBuffer(4)
const FILE = { id: 'f1', originalName: 'walden.epub', hasContent: true, format: 'epub', sha256: 'ab'.repeat(32), byteSize: 4 }

// The app's routes (App.tsx): every reader path is this page.
function renderPage(path = '/en/library/my/bk-1/read-v2') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/:lang/library/my/:id/read" element={<ReaderPage />} />
          <Route path="/:lang/library/my/:id/read/:chapterSlug" element={<ReaderPage />} />
          <Route path="/:lang/library/my/:id/read-v2" element={<ReaderPage />} />
        </Routes>
      </Suspense>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  syncSwitch.mockResolvedValue({ enabled: true, maxPartBytes: 0 })
  syncAnswer.mockReturnValue(null)
  liveBook.mockResolvedValue({ id: 'bk-1', title: 'Walden', currentFile: FILE })
  fetchFileBytes.mockResolvedValue(BYTES)
  pullBooks.mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())

describe('ReaderPage', () => {
  it.each(['/en/library/my/bk-1/read', '/en/library/my/bk-1/read/ch-3', '/en/library/my/bk-1/read-v2'])('%s_OpensTheBookInTheReader', async (path) => {
    renderPage(path)
    await vi.waitFor(() => expect(fetchFileBytes).toHaveBeenCalledWith('bk-1', 'f1', expect.any(Function), expect.any(AbortSignal)))
    expect(screen.getByTestId('host')).toBeInTheDocument()
  })

  // Review #1361: an in-app open after the probe answered opens at once, no blank wait on the session bootstrap.
  it('probeAlreadyAnswered_OpensAtOnce_WhileAStatusCallIsStillPending', async () => {
    syncAnswer.mockReturnValue(true)
    syncSwitch.mockReturnValue(new Promise(() => {}))
    renderPage('/en/library/my/bk-1/read')
    await vi.waitFor(() => expect(liveBook).toHaveBeenCalledWith('bk-1'))
  })

  it('beforeTheProbe_RendersNothing', () => {
    syncSwitch.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(screen.queryByTestId('host')).toBeNull()
  })

  it('syncOn_TheCurrentFilesBytes_GoToTheHost_WithItsServerSyncTarget', async () => {
    renderPage()
    const sync = { bookId: 'bk-1', fileId: 'f1', format: 'epub', sha256: 'ab'.repeat(32), size: 4, name: 'walden.epub' }
    await vi.waitFor(() => expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ book: { bytes: BYTES, name: 'walden.epub', sync } })))
    expect(fetchFileBytes).toHaveBeenCalledWith('bk-1', 'f1', expect.any(Function), expect.any(AbortSignal))
  })

  it('fetchFails_ShowsTheErrorLine', async () => {
    fetchFileBytes.mockRejectedValue(new Error('HTTP 404'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the book: HTTP 404')
    // No "Loading the book…" beside the error.
    expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ idleHeading: '' }))
  })

  it('theProdRoute_A30sReadyDeadline_NoDevAids', async () => {
    renderPage()
    await vi.waitFor(() => expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ readyDeadlineMs: 30_000, idleHeading: 'Loading the book…' })))
    expect(hostProps.mock.calls[hostProps.mock.calls.length - 1][0]).not.toHaveProperty('dev')
  })

  it('noFileContent_ShowsTheErrorLine_FetchesNothing', async () => {
    liveBook.mockResolvedValue({ id: 'bk-1', title: 'Walden', currentFile: { ...FILE, hasContent: false } })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('This book has no file to read yet.')
    expect(fetchFileBytes).not.toHaveBeenCalled()
  })

  // #1227: the load's failures by cause; Retry only where trying again can help.
  const apiError = (status: number, code?: string, network = false) => {
    const e = new ApiError(status, code ?? `API error: ${status}`)
    if (code) e.body = { code, message: code }
    e.isNetworkError = network
    return e
  }
  it.each([
    ['401: the session', apiError(401), 'Your session has ended', false],
    // Twice: the first is checked against a fresh pull of the library.
    ['404 (twice): the book or file gone', apiError(404, 'file_not_found'), 'no longer in your library', false],
    ['offline', apiError(0, undefined, true), 'You are offline', true],
    ['503 v2_unavailable', apiError(503, 'v2_unavailable'), 'unavailable right now', true],
    ['anything else', new Error('boom'), 'Could not load the book: boom', true],
  ])('fetchFails %s: its message, Retry %s', async (_, err, text, retry) => {
    fetchFileBytes.mockRejectedValueOnce(err)
    if ((err as ApiError).status === 404) fetchFileBytes.mockRejectedValueOnce(err)
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    const button = screen.queryByRole('button', { name: 'Retry' })
    expect(button !== null).toBe(retry)
    if (!button) return
    button.click()
    const sync = expect.objectContaining({ fileId: 'f1' })
    await vi.waitFor(() => expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ book: { bytes: BYTES, name: 'walden.epub', sync } })))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('whileTheBytesComeIn_ProgressFromContentLength_AsTheIdleHeading', async () => {
    let progress: (loaded: number, total: number | null) => void = () => {}
    fetchFileBytes.mockImplementation((_id: string, _f: string, p: typeof progress) => { progress = p; return new Promise(() => {}) })
    renderPage()
    await vi.waitFor(() => expect(fetchFileBytes).toHaveBeenCalled())
    expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ idleHeading: 'Loading the book…' }))
    act(() => progress(50, 200))
    expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ idleHeading: 'Downloading the book… 25%' }))
    act(() => progress(250, 200)) // a Content-Length that undercounts: never "100 %" before the bytes are in
    expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ idleHeading: 'Downloading the book… 99%' }))
    act(() => progress(10, null)) // no Content-Length: the plain line stays as it was
    expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ idleHeading: 'Downloading the book… 99%' }))
  })

  it('theHostsReload_FetchesTheBytesAgain', async () => {
    renderPage()
    await vi.waitFor(() => expect(fetchFileBytes).toHaveBeenCalledTimes(1))
    const { onReload } = hostProps.mock.calls[hostProps.mock.calls.length - 1][0] as { onReload: () => void }
    act(() => onReload())
    await vi.waitFor(() => expect(fetchFileBytes).toHaveBeenCalledTimes(2))
  })

  it('a404FromTheSessionsCopy_AFreshPull_TheNewFileOpens', async () => {
    const f2 = { ...FILE, id: 'f2' }
    liveBook.mockResolvedValueOnce({ id: 'bk-1', currentFile: FILE }).mockResolvedValueOnce({ id: 'bk-1', currentFile: f2 })
    fetchFileBytes.mockRejectedValueOnce(apiError(404, 'file_not_found'))
    renderPage()
    await vi.waitFor(() => expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ book: expect.objectContaining({ sync: expect.objectContaining({ fileId: 'f2' }) }) })))
    expect(pullBooks).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('noFileInTheSessionsCopy_AFreshPull_TheFileOpens', async () => {
    liveBook.mockResolvedValueOnce({ id: 'bk-1', currentFile: { ...FILE, hasContent: false } })
    renderPage()
    await vi.waitFor(() => expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ book: expect.objectContaining({ bytes: BYTES }) })))
    expect(pullBooks).toHaveBeenCalledOnce()
  })

  it('otherFailures_NoFreshPull', async () => {
    fetchFileBytes.mockRejectedValueOnce(apiError(503, 'v2_unavailable'))
    renderPage()
    await screen.findByRole('alert')
    expect(pullBooks).not.toHaveBeenCalled()
  })

  /** A download that sends `progress` calls and ends only by its signal. */
  const hanging = () => {
    const at: { progress: (l: number, t: number | null) => void; signal?: AbortSignal } = { progress: () => {} }
    fetchFileBytes.mockImplementation((_i: string, _f: string, p: typeof at.progress, signal: AbortSignal) => {
      at.progress = p
      at.signal = signal
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    })
    return at
  }

  it('noBytesForTheStallTime_StalledAlertWithRetry_ProgressResetsTheClock', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const d = hanging()
    renderPage()
    await vi.waitFor(() => expect(d.signal).toBeDefined())
    act(() => { vi.advanceTimersByTime(DOWNLOAD_STALL_MS - 1000) })
    act(() => d.progress(100, 1000))
    act(() => { vi.advanceTimersByTime(DOWNLOAD_STALL_MS - 1000) })
    await act(async () => {}) // a stall would have rejected by now
    expect(d.signal!.aborted).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
    // Due, but one grace second first (a frozen tab's chunks may still be queued).
    act(() => { vi.advanceTimersByTime(1000) })
    expect(d.signal!.aborted).toBe(false)
    act(() => { vi.advanceTimersByTime(STALL_GRACE_MS) })
    expect(await screen.findByRole('alert')).toHaveTextContent(`The download stopped: nothing arrived for ${DOWNLOAD_STALL_MS / 1000} s.`)
    expect(d.signal!.aborted).toBe(true)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('libraryNeverAnswers_StalledAlertWithRetry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    liveBook.mockReturnValue(new Promise(() => {}))
    renderPage()
    await vi.waitFor(() => expect(liveBook).toHaveBeenCalled())
    act(() => { vi.advanceTimersByTime(DOWNLOAD_STALL_MS + STALL_GRACE_MS) })
    expect(await screen.findByRole('alert')).toHaveTextContent('The download stopped')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(fetchFileBytes).not.toHaveBeenCalled()
  })

  it('unmount_AbortsTheDownload_NoAlert', async () => {
    const d = hanging()
    const view = renderPage()
    await vi.waitFor(() => expect(d.signal).toBeDefined())
    view.unmount()
    expect(d.signal!.aborted).toBe(true)
  })

  it('retry_AbortsTheDownloadInFlight', async () => {
    const d = hanging()
    renderPage()
    await vi.waitFor(() => expect(d.signal).toBeDefined())
    const first = d.signal!
    const { onReload } = hostProps.mock.calls[hostProps.mock.calls.length - 1][0] as { onReload: () => void }
    act(() => onReload())
    expect(first.aborted).toBe(true)
  })

  it('progressAtTheSamePercent_NoRender', async () => {
    const d = hanging()
    renderPage()
    await vi.waitFor(() => expect(d.signal).toBeDefined())
    act(() => d.progress(100, 1000))
    const renders = hostProps.mock.calls.length
    act(() => d.progress(105, 1000))
    expect(hostProps.mock.calls.length).toBe(renders)
    act(() => d.progress(200, 1000))
    expect(hostProps.mock.calls.length).toBeGreaterThan(renders)
  })
})
