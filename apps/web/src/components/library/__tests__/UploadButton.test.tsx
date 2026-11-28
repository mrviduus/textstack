import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const useAuthMock = vi.fn()
const ensureSession = vi.fn(async () => true)
const openAuthModal = vi.fn()
const auth = (over: object = {}) => ({ isLoading: false, waitForSession: async () => {}, ensureSession, openAuthModal, ...over })

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
    openAuthModal.mockClear()
  })
  afterEach(() => cleanup())

  it('renders nothing while auth is loading', () => {
    useAuthMock.mockReturnValue(auth({ isLoading: true }))
    const { container } = render(<UploadButton />)
    expect(container.firstChild).toBeNull()
  })

  it('opens the upload dialog on click, with no menu between', async () => {
    useAuthMock.mockReturnValue(auth())
    render(<UploadButton />)
    expect(screen.queryByTestId('modal')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'upload.button' }))
    expect(await screen.findByTestId('modal')).toBeInTheDocument()
  })

  it('gives a reader with no session a session before the dialog', async () => {
    useAuthMock.mockReturnValue(auth())
    render(<UploadButton />)
    fireEvent.click(screen.getByRole('button', { name: 'upload.button' }))
    await screen.findByTestId('modal')
    expect(ensureSession).toHaveBeenCalledTimes(1)
  })

  it('opens the dialog for the tab bar and the library button (the open-upload event)', async () => {
    useAuthMock.mockReturnValue(auth())
    render(<UploadButton />)
    window.dispatchEvent(new Event('textstack:open-upload'))
    expect(await screen.findByTestId('modal')).toBeInTheDocument()
  })

  it('asks to sign in, with no dialog, when no session can be made', async () => {
    useAuthMock.mockReturnValue(auth({ ensureSession: vi.fn(async () => false) }))
    render(<UploadButton />)
    fireEvent.click(screen.getByRole('button', { name: 'upload.button' }))
    await vi.waitFor(() => expect(openAuthModal).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('modal')).toBeNull()
  })

  it('waits for the start-up session check before it makes a guest', async () => {
    let settle!: () => void
    const waitForSession = () => new Promise<void>((r) => { settle = r })
    useAuthMock.mockReturnValue(auth({ waitForSession }))
    render(<UploadButton />)
    fireEvent.click(screen.getByRole('button', { name: 'upload.button' }))
    await Promise.resolve()
    expect(ensureSession).not.toHaveBeenCalled()
    settle()
    expect(await screen.findByTestId('modal')).toBeInTheDocument()
    expect(ensureSession).toHaveBeenCalledTimes(1)
  })
})
