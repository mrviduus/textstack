import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const useAuthMock = vi.fn()
const ensureSession = vi.fn(async () => {})

vi.mock('../../../context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}))
vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('../UploadModal', () => ({
  UploadModal: ({ open }: { open: boolean }) => (open ? <div data-testid="modal" /> : null),
}))

import { UploadButton } from '../UploadButton'

describe('UploadButton', () => {
  beforeEach(() => {
    useAuthMock.mockReset()
    ensureSession.mockClear()
  })
  afterEach(() => cleanup())

  it('renders nothing while auth is loading', () => {
    useAuthMock.mockReturnValue({ isAuthenticated: false, isLoading: true })
    const { container } = render(<UploadButton />)
    expect(container.firstChild).toBeNull()
  })

  it('opens the upload dialog on click, with no menu between', async () => {
    useAuthMock.mockReturnValue({ isLoading: false, ensureSession })
    render(<UploadButton />)
    expect(screen.queryByTestId('modal')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'upload.button' }))
    expect(await screen.findByTestId('modal')).toBeInTheDocument()
  })

  it('gives a reader with no session a session before the dialog', async () => {
    useAuthMock.mockReturnValue({ isLoading: false, ensureSession })
    render(<UploadButton />)
    fireEvent.click(screen.getByRole('button', { name: 'upload.button' }))
    await screen.findByTestId('modal')
    expect(ensureSession).toHaveBeenCalledTimes(1)
  })

  it('opens the dialog for the tab bar and the library button (the open-upload event)', async () => {
    useAuthMock.mockReturnValue({ isLoading: false, ensureSession })
    render(<UploadButton />)
    window.dispatchEvent(new Event('textstack:open-upload'))
    expect(await screen.findByTestId('modal')).toBeInTheDocument()
  })

  it('still opens the dialog when the guest session cannot be made', async () => {
    useAuthMock.mockReturnValue({ isLoading: false, ensureSession: vi.fn(async () => { throw new Error('offline') }) })
    render(<UploadButton />)
    fireEvent.click(screen.getByRole('button', { name: 'upload.button' }))
    expect(await screen.findByTestId('modal')).toBeInTheDocument()
  })
})
