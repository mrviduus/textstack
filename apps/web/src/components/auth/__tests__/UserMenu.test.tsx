import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { UserMenu } from '../UserMenu'

const authUser = {
  id: 'u1',
  email: 'a@b.com',
  name: 'Test User' as string | null,
  picture: null,
  isGuest: false,
  nativeLanguage: 'en',
}
const guestUser = { ...authUser, email: 'guest-ab12@guest.local', name: null, isGuest: true }

const auth = {
  user: authUser as typeof authUser,
  logout: vi.fn(async () => {}),
  openAuthModal: vi.fn(),
  deleteAccount: vi.fn(async () => {}),
}

vi.mock('../../../context/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../../../context/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'en',
    getLocalizedPath: (p: string) => `/en${p}`,
    switchLanguage: () => {},
  }),
}))
vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('../../../hooks/useOnline', () => ({ useOnline: () => true }))
vi.mock('../../../lib/userInitials', () => ({ getUserInitials: () => 'TU' }))
vi.mock('../ProfileModal', () => ({ ProfileModal: () => null }))

function open(name: RegExp) {
  render(
    <MemoryRouter>
      <UserMenu />
    </MemoryRouter>
  )
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('UserMenu', () => {
  beforeEach(() => {
    auth.user = authUser
    auth.logout.mockClear()
    auth.openAuthModal.mockClear()
    auth.deleteAccount.mockReset().mockResolvedValue(undefined)
  })

  it('drops legacy items: My Library / Highlights / Vocabulary / My language', () => {
    open(/Test User/i)
    expect(screen.queryByText('My Library')).not.toBeInTheDocument()
    expect(screen.queryByText('Highlights')).not.toBeInTheDocument()
    expect(screen.queryByText('Vocabulary')).not.toBeInTheDocument()
    expect(screen.queryByText('My language')).not.toBeInTheDocument()
  })

  it('keeps Edit profile + Sign out for an account, no guest items', () => {
    open(/Test User/i)
    expect(screen.getByText('Edit profile')).toBeInTheDocument()
    expect(screen.getByText('Sign out')).toBeInTheDocument()
    expect(screen.queryByText('guest.createAccount')).not.toBeInTheDocument()
    expect(screen.queryByText('guest.deleteData')).not.toBeInTheDocument()
  })

  describe('guest', () => {
    beforeEach(() => { auth.user = guestUser })

    it('is named "Guest", never shows the synthetic email', () => {
      open(/guest\.name/)
      expect(screen.getAllByText('guest.name').length).toBeGreaterThan(0)
      expect(screen.queryByText(guestUser.email)).not.toBeInTheDocument()
    })

    it('Create account opens the auth modal on the register tab', () => {
      open(/guest\.name/)
      fireEvent.click(screen.getByText('guest.createAccount'))
      expect(auth.openAuthModal).toHaveBeenLastCalledWith('register')
    })

    it('I already have an account opens it on the login tab', () => {
      open(/guest\.name/)
      fireEvent.click(screen.getByText('guest.cardSignIn'))
      expect(auth.openAuthModal).toHaveBeenLastCalledWith('login')
    })

    it('has no plain Sign out — Delete guest data goes through a confirm', async () => {
      open(/guest\.name/)
      expect(screen.queryByText('Sign out')).not.toBeInTheDocument()
      fireEvent.click(screen.getByText('guest.deleteData'))
      expect(auth.deleteAccount).not.toHaveBeenCalled()
      expect(screen.getByText('guest.deleteTitle')).toBeInTheDocument()
      fireEvent.click(screen.getByText('guest.deleteConfirm'))
      await waitFor(() => expect(auth.deleteAccount).toHaveBeenCalledTimes(1))
      expect(auth.logout).not.toHaveBeenCalled()
    })

    it('cancel keeps everything', () => {
      open(/guest\.name/)
      fireEvent.click(screen.getByText('guest.deleteData'))
      fireEvent.click(screen.getByText('guest.deleteCancel'))
      expect(auth.deleteAccount).not.toHaveBeenCalled()
      expect(screen.queryByText('guest.deleteTitle')).not.toBeInTheDocument()
    })

    it('a failed delete still drops the session locally', async () => {
      auth.deleteAccount.mockRejectedValue(new Error('offline'))
      open(/guest\.name/)
      fireEvent.click(screen.getByText('guest.deleteData'))
      fireEvent.click(screen.getByText('guest.deleteConfirm'))
      await waitFor(() => expect(auth.logout).toHaveBeenCalledTimes(1))
    })
  })
})
