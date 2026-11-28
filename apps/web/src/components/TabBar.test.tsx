import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ isAuthenticated: false, openAuthModal: vi.fn() }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }))
const shell = vi.hoisted(() => ({ appShell: false }))
vi.mock('../platform', () => ({ platform: { get appShell() { return shell.appShell } } }))
vi.mock('./auth/ProfileModal', () => ({ ProfileModal: () => <div>the profile</div> }))

import { TabBar } from './TabBar'

const at = (path: string) => render(<MemoryRouter initialEntries={[path]}><TabBar /></MemoryRouter>)

describe('the phone tab bar', () => {
  beforeEach(() => { auth.isAuthenticated = false; auth.openAuthModal.mockReset(); shell.appShell = false })

  it('shows at every width in the Android app, and leaves with the page', () => {
    shell.appShell = true
    const { unmount } = at('/en/library')
    expect(document.documentElement).toHaveClass('has-tab-bar')
    unmount()
    expect(document.documentElement).not.toHaveClass('has-tab-bar')
  })

  it('stays hidden on a wide website', () => {
    at('/en/library')
    expect(document.documentElement).not.toHaveClass('has-tab-bar')
  })

  it('marks the tab of the page the reader is on', () => {
    at('/en/library')
    expect(screen.getByRole('link', { name: /library/i })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /vocabulary/i })).not.toHaveAttribute('aria-current')
  })

  it('keeps the Library tab marked on a book page', () => {
    at('/en/library/my/42')
    expect(screen.getByRole('link', { name: /library/i })).toHaveAttribute('aria-current', 'page')
  })

  it('opens the upload dialog for "+" with no session, and asks to sign in for Profile', () => {
    const opened = vi.fn()
    window.addEventListener('textstack:open-upload', opened)
    at('/en/library')
    fireEvent.click(screen.getByRole('button', { name: /upload/i }))
    fireEvent.click(screen.getByRole('button', { name: /profile/i }))
    window.removeEventListener('textstack:open-upload', opened)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(auth.openAuthModal).toHaveBeenCalledTimes(1)
  })

  it('opens the upload dialog and the profile for a reader with a session', () => {
    auth.isAuthenticated = true
    const opened = vi.fn()
    window.addEventListener('textstack:open-upload', opened)
    at('/en/vocabulary')
    fireEvent.click(screen.getByRole('button', { name: /upload/i }))
    fireEvent.click(screen.getByRole('button', { name: /profile/i }))
    window.removeEventListener('textstack:open-upload', opened)
    expect(opened).toHaveBeenCalledTimes(1)
    expect(screen.getByText('the profile')).toBeInTheDocument()
  })
})
