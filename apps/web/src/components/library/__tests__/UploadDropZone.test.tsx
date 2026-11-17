import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const useAuthMock = vi.fn()
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
    isMobileMock = false
  })
  afterEach(() => cleanup())

  it('renders headline + cta', () => {
    useAuthMock.mockReturnValue({ isAuthenticated: true })
    render(<UploadDropZone />)
    expect(screen.getByText('library.empty.uploads.title')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'library.empty.uploads.cta' })).toBeInTheDocument()
  })

  it('shows shortcut hint on desktop, hides on mobile', () => {
    useAuthMock.mockReturnValue({ isAuthenticated: true })
    isMobileMock = false
    const { unmount } = render(<UploadDropZone />)
    expect(screen.getByText('library.empty.uploads.shortcut')).toBeInTheDocument()
    unmount()
    isMobileMock = true
    render(<UploadDropZone />)
    expect(screen.queryByText('library.empty.uploads.shortcut')).toBeNull()
  })

  it('disables CTA when unauthenticated', () => {
    useAuthMock.mockReturnValue({ isAuthenticated: false })
    render(<UploadDropZone />)
    const btn = screen.getByRole('button', { name: 'library.empty.uploads.cta' })
    expect(btn).toBeDisabled()
  })

  it('opens modal with selected valid file', () => {
    useAuthMock.mockReturnValue({ isAuthenticated: true })
    const { container } = render(<UploadDropZone />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'novel.epub', { type: 'application/epub+zip' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    const modal = screen.getByTestId('modal')
    expect(modal).toBeInTheDocument()
    expect(modal.getAttribute('data-file')).toBe('novel.epub')
  })

  it('rejects invalid file (no modal opens)', () => {
    useAuthMock.mockReturnValue({ isAuthenticated: true })
    const { container } = render(<UploadDropZone />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'image.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    expect(screen.queryByTestId('modal')).toBeNull()
  })
})
