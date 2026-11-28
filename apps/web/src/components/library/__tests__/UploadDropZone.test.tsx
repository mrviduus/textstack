import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const useAuthMock = vi.fn()
const ensureSession = vi.fn(async () => {})
let isMobileMock = false

vi.mock('../../../context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}))
vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => isMobileMock,
}))
vi.mock('../UploadModal', () => ({
  UploadModal: ({ open, initialFile }: { open: boolean; initialFile?: File }) =>
    open ? <div data-testid="modal" data-file={initialFile?.name ?? ''} /> : null,
}))

import { UploadDropZone } from '../UploadDropZone'

describe('UploadDropZone', () => {
  beforeEach(() => {
    useAuthMock.mockReset()
    ensureSession.mockClear()
    isMobileMock = false
  })
  afterEach(() => cleanup())

  it('renders headline + cta', () => {
    useAuthMock.mockReturnValue({ ensureSession })
    render(<UploadDropZone />)
    expect(screen.getByText('library.empty.uploads.title')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'library.empty.uploads.cta' })).toBeInTheDocument()
  })

  it('shows shortcut hint on desktop, hides on mobile', () => {
    useAuthMock.mockReturnValue({ ensureSession })
    isMobileMock = false
    const { unmount } = render(<UploadDropZone />)
    expect(screen.getByText('library.empty.uploads.shortcut')).toBeInTheDocument()
    unmount()
    isMobileMock = true
    render(<UploadDropZone />)
    expect(screen.queryByText('library.empty.uploads.shortcut')).toBeNull()
  })

  it('offers the CTA to a reader with no session', () => {
    useAuthMock.mockReturnValue({ ensureSession })
    render(<UploadDropZone />)
    expect(screen.getByRole('button', { name: 'library.empty.uploads.cta' })).toBeEnabled()
  })

  it('opens modal with selected valid file, after a session is there', async () => {
    useAuthMock.mockReturnValue({ ensureSession })
    const { container } = render(<UploadDropZone />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'novel.epub', { type: 'application/epub+zip' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    const modal = await screen.findByTestId('modal')
    expect(ensureSession).toHaveBeenCalledTimes(1)
    expect(modal.getAttribute('data-file')).toBe('novel.epub')
  })

  it('rejects invalid file (no modal opens)', () => {
    useAuthMock.mockReturnValue({ ensureSession })
    const { container } = render(<UploadDropZone />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'image.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    expect(screen.queryByTestId('modal')).toBeNull()
  })
})
