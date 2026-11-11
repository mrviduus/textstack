import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// #1225: /:lang/library/my/:id/read-v2 — gated on the V2 probe, the current file's bytes into the host.
const v2Status = vi.fn()
const v2Book = vi.fn()
const fetchV2FileBytes = vi.fn()
vi.mock('../../api/v2', () => ({
  v2Status: () => v2Status(),
  v2Book: (id: string) => v2Book(id),
  fetchV2FileBytes: (id: string, fileId: string) => fetchV2FileBytes(id, fileId),
}))
const hostProps = vi.fn()
vi.mock('../../components/reader/V2ReaderHost', () => ({
  V2ReaderHost: (p: { book: unknown; children?: React.ReactNode }) => { hostProps(p); return <div data-testid="host">{p.children}</div> },
}))
vi.mock('../../components/SeoHead', () => ({ SeoHead: () => null }))

import { V2ReaderPage } from '../V2ReaderPage'

const BYTES = new ArrayBuffer(4)
const FILE = { id: 'f1', originalName: 'walden.epub', hasContent: true }

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

  it('v2On_TheCurrentFilesBytes_GoToTheHost', async () => {
    renderPage()
    await vi.waitFor(() => expect(hostProps).toHaveBeenLastCalledWith(expect.objectContaining({ book: { bytes: BYTES, name: 'walden.epub' } })))
    expect(fetchV2FileBytes).toHaveBeenCalledWith('bk-1', 'f1')
  })

  it('fetchFails_ShowsTheErrorLine', async () => {
    fetchV2FileBytes.mockRejectedValue(new Error('HTTP 404'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the book: HTTP 404')
  })

  it('noFileContent_ShowsTheErrorLine_FetchesNothing', async () => {
    v2Book.mockResolvedValue({ id: 'bk-1', title: 'Walden', currentFile: { ...FILE, hasContent: false } })
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('This book has no file to read yet.')
    expect(fetchV2FileBytes).not.toHaveBeenCalled()
  })
})
