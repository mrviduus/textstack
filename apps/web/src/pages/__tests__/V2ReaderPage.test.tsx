import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ApiError } from '@textstack/shared'

// #1225: /:lang/library/my/:id/read-v2 — gated on the V2 probe, the current file's bytes into the host.
const v2Status = vi.fn()
const v2Book = vi.fn()
const fetchV2FileBytes = vi.fn()
const pullV2Books = vi.fn()
vi.mock('../../api/v2', () => ({
  pullV2Books: () => pullV2Books(),
  v2Status: () => v2Status(),
  v2Book: (id: string) => v2Book(id),
  fetchV2FileBytes: (...args: unknown[]) => fetchV2FileBytes(...args),
}))
const hostProps = vi.fn()
vi.mock('../../components/reader/V2ReaderHost', () => ({
  V2ReaderHost: (p: { book: unknown; children?: React.ReactNode }) => { hostProps(p); return <div data-testid="host">{p.children}</div> },
}))
vi.mock('../../components/SeoHead', () => ({ SeoHead: () => null }))

import { STALL_GRACE_MS, V2ReaderPage } from '../V2ReaderPage'
import { DOWNLOAD_STALL_MS } from '../../../../mobile/src/lib/v2reader/deadlines.mjs'

const BYTES = new ArrayBuffer(4)
const FILE = { id: 'f1', originalName: 'walden.epub', hasContent: true, format: 'epub', sha256: 'ab'.repeat(32), byteSize: 4 }

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/en/library/my/bk-1/read-v2']}>
      <Routes>
        <Route path="/:lang/library/my/:id/read-v2" element={<V2ReaderPage />} />
        <Route path="/:lang/library/my/:id/read" element={<div data-testid="legacy" />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  v2Status.mockResolvedValue({ enabled: true, maxPartBytes: 0 })
  v2Book.mockResolvedValue({ id: 'bk-1', title: 'Walden', currentFile: FILE })
  fetchV2FileBytes.mockResolvedValue(BYTES)
  pullV2Books.mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())

describe('V2ReaderPage', () => {
  it('v2Off_RedirectsToTheLegacyReader_FetchesNothing', async () => {
    v2Status.mockResolvedValue({ enabled: false, maxPartBytes: 0 })
    renderPage()
    expect(await screen.findByTestId('legacy')).toBeInTheDocument()
    expect(v2Book).not.toHaveBeenCalled()
    expect(fetchV2FileBytes).not.toHaveBeenCalled()
  })

  it('beforeTheProbe_RendersNothing', () => {
    v2Status.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(screen.queryByTestId('host')).toBeNull()
    expect(screen.queryByTestId('legacy')).toBeNull()
  })

  it('v2On_TheCurrentFilesBytes_GoToTheHost_WithItsServerSyncTarget', async () => {
    renderPage()
    const sync = { bookId: 'bk-1', fileId: 'f1', format: 'epub', sha256: 'ab'.repeat(32), size: 4, name: 'walden.epub' }
    await vi.waitFor(() => expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ book: { bytes: BYTES, name: 'walden.epub', sync } })))
    expect(fetchV2FileBytes).toHaveBeenCalledWith('bk-1', 'f1', expect.any(Function), expect.any(AbortSignal))
  })

  it('fetchFails_ShowsTheErrorLine', async () => {
    fetchV2FileBytes.mockRejectedValue(new Error('HTTP 404'))
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
    v2Book.mockResolvedValue({ id: 'bk-1', title: 'Walden', currentFile: { ...FILE, hasContent: false } })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('This book has no file to read yet.')
    expect(fetchV2FileBytes).not.toHaveBeenCalled()
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
    fetchV2FileBytes.mockRejectedValueOnce(err)
    if ((err as ApiError).status === 404) fetchV2FileBytes.mockRejectedValueOnce(err)
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
    fetchV2FileBytes.mockImplementation((_id: string, _f: string, p: typeof progress) => { progress = p; return new Promise(() => {}) })
    renderPage()
    await vi.waitFor(() => expect(fetchV2FileBytes).toHaveBeenCalled())
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
    await vi.waitFor(() => expect(fetchV2FileBytes).toHaveBeenCalledTimes(1))
    const { onReload } = hostProps.mock.calls[hostProps.mock.calls.length - 1][0] as { onReload: () => void }
    act(() => onReload())
    await vi.waitFor(() => expect(fetchV2FileBytes).toHaveBeenCalledTimes(2))
  })

  it('a404FromTheSessionsCopy_AFreshPull_TheNewFileOpens', async () => {
    const f2 = { ...FILE, id: 'f2' }
    v2Book.mockResolvedValueOnce({ id: 'bk-1', currentFile: FILE }).mockResolvedValueOnce({ id: 'bk-1', currentFile: f2 })
    fetchV2FileBytes.mockRejectedValueOnce(apiError(404, 'file_not_found'))
    renderPage()
    await vi.waitFor(() => expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ book: expect.objectContaining({ sync: expect.objectContaining({ fileId: 'f2' }) }) })))
    expect(pullV2Books).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('noFileInTheSessionsCopy_AFreshPull_TheFileOpens', async () => {
    v2Book.mockResolvedValueOnce({ id: 'bk-1', currentFile: { ...FILE, hasContent: false } })
    renderPage()
    await vi.waitFor(() => expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ book: expect.objectContaining({ bytes: BYTES }) })))
    expect(pullV2Books).toHaveBeenCalledOnce()
  })

  it('otherFailures_NoFreshPull', async () => {
    fetchV2FileBytes.mockRejectedValueOnce(apiError(503, 'v2_unavailable'))
    renderPage()
    await screen.findByRole('alert')
    expect(pullV2Books).not.toHaveBeenCalled()
  })

  /** A download that sends `progress` calls and ends only by its signal. */
  const hanging = () => {
    const at: { progress: (l: number, t: number | null) => void; signal?: AbortSignal } = { progress: () => {} }
    fetchV2FileBytes.mockImplementation((_i: string, _f: string, p: typeof at.progress, signal: AbortSignal) => {
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
    v2Book.mockReturnValue(new Promise(() => {}))
    renderPage()
    await vi.waitFor(() => expect(v2Book).toHaveBeenCalled())
    act(() => { vi.advanceTimersByTime(DOWNLOAD_STALL_MS + STALL_GRACE_MS) })
    expect(await screen.findByRole('alert')).toHaveTextContent('The download stopped')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(fetchV2FileBytes).not.toHaveBeenCalled()
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
