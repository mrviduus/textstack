import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ApiError } from '@textstack/shared'

// #1225: /:lang/library/my/:id/read-v2 — gated on the V2 probe, the current file's bytes into the host.
const v2Status = vi.fn()
const v2Book = vi.fn()
const fetchV2FileBytes = vi.fn()
vi.mock('../../api/v2', () => ({
  v2Status: () => v2Status(),
  v2Book: (id: string) => v2Book(id),
  fetchV2FileBytes: (...args: unknown[]) => fetchV2FileBytes(...args),
}))
const hostProps = vi.fn()
vi.mock('../../components/reader/V2ReaderHost', () => ({
  V2ReaderHost: (p: { book: unknown; children?: React.ReactNode }) => { hostProps(p); return <div data-testid="host">{p.children}</div> },
}))
vi.mock('../../components/SeoHead', () => ({ SeoHead: () => null }))

import { V2ReaderPage } from '../V2ReaderPage'

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
})

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
    expect(fetchV2FileBytes).toHaveBeenCalledWith('bk-1', 'f1', expect.any(Function))
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
    ['404: the book or file gone', apiError(404, 'file_not_found'), 'no longer in your library', false],
    ['offline', apiError(0, undefined, true), 'You are offline', true],
    ['503 v2_unavailable', apiError(503, 'v2_unavailable'), 'unavailable right now', true],
    ['anything else', new Error('boom'), 'Could not load the book: boom', true],
  ])('fetchFails %s: its message, Retry %s', async (_, err, text, retry) => {
    fetchV2FileBytes.mockRejectedValueOnce(err)
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
})
