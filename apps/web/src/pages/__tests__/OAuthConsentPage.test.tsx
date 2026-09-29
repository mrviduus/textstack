import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (k: string, p?: Record<string, string>) => (p ? `${k}:${Object.values(p).join(',')}` : k),
  }),
}))
vi.mock('../../components/SeoHead', () => ({ SeoHead: () => null }))
vi.mock('../../components/LocalizedLink', () => ({
  LocalizedLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

const { auth, api } = vi.hoisted(() => ({
  auth: {
    user: { email: 'vasyl@example.com' } as { email: string } | null,
    isLoading: false,
    isAuthenticated: true,
    isGuest: false,
    openAuthModal: vi.fn(),
    logout: vi.fn(),
  },
  api: { getOAuthRequest: vi.fn(), approveOAuthRequest: vi.fn(), denyOAuthRequest: vi.fn() },
}))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../../api/oauth', () => api)

import { OAuthConsentPage, navigateTo } from '../OAuthConsentPage'

const pending = {
  id: 'r1', clientName: 'Claude', clientId: 'c', redirectHost: 'claude.ai', scope: 'library',
  scopeDescription: 'x', status: 'pending', expiresAt: '2099-01-01T00:00:00Z',
}

const renderPage = (req = 'r1') =>
  render(
    <MemoryRouter initialEntries={[`/en/oauth/consent?req=${req}`]}>
      <OAuthConsentPage />
    </MemoryRouter>,
  )

let go: ReturnType<typeof vi.fn<(url: string) => void>>

beforeEach(() => {
  Object.assign(auth, { user: { email: 'vasyl@example.com' }, isLoading: false, isAuthenticated: true, isGuest: false })
  auth.openAuthModal.mockReset()
  auth.logout.mockReset().mockResolvedValue(undefined)
  api.getOAuthRequest.mockReset().mockResolvedValue(pending)
  api.approveOAuthRequest.mockReset().mockResolvedValue('http://127.0.0.1:9/cb?code=abc&state=s')
  api.denyOAuthRequest.mockReset().mockResolvedValue('http://127.0.0.1:9/cb?error=access_denied')
  go = vi.fn<(url: string) => void>()
  navigateTo.go = go
})
afterEach(() => cleanup())

describe('OAuthConsentPage', () => {
  it('shows loading until the request arrives', () => {
    api.getOAuthRequest.mockReturnValue(new Promise(() => {}))
    renderPage()
    expect(screen.getByText('oauthConsent.loading')).toBeTruthy()
  })

  it('pending: shows client + redirect host; Allow approves and navigates to the redirect', async () => {
    renderPage()
    await screen.findByText('oauthConsent.title:Claude')
    expect(screen.getByText('claude.ai')).toBeTruthy()
    expect(screen.getByText('oauthConsent.signedInAs:vasyl@example.com')).toBeTruthy()

    fireEvent.click(screen.getByText('oauthConsent.allow'))
    await waitFor(() => expect(go).toHaveBeenCalledWith('http://127.0.0.1:9/cb?code=abc&state=s'))
    expect(api.approveOAuthRequest).toHaveBeenCalledWith('r1')
  })

  it('Cancel denies and navigates to the error redirect', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('oauthConsent.cancel'))
    await waitFor(() => expect(go).toHaveBeenCalledWith('http://127.0.0.1:9/cb?error=access_denied'))
    expect(api.denyOAuthRequest).toHaveBeenCalledWith('r1')
    expect(api.approveOAuthRequest).not.toHaveBeenCalled()
  })

  it('guest: register CTA, never calls approve', async () => {
    auth.isGuest = true
    renderPage()
    await screen.findByText('oauthConsent.guestText')
    expect(screen.queryByText('oauthConsent.allow')).toBeNull()
    fireEvent.click(screen.getByText('oauthConsent.guestCta'))
    expect(auth.openAuthModal).toHaveBeenCalled()
    expect(api.approveOAuthRequest).not.toHaveBeenCalled()
  })

  it('403 account_required from approve falls back to the guest CTA', async () => {
    api.approveOAuthRequest.mockRejectedValue(Object.assign(new Error('account_required'), { status: 403 }))
    renderPage()
    fireEvent.click(await screen.findByText('oauthConsent.allow'))
    await screen.findByText('oauthConsent.guestText')
    expect(go).not.toHaveBeenCalled()
  })

  it.each(['expired', 'approved', 'denied'])('%s request: expired message, no actions', async status => {
    api.getOAuthRequest.mockResolvedValue({ ...pending, status })
    renderPage()
    await screen.findByText('oauthConsent.expiredText')
    expect(screen.queryByText('oauthConsent.allow')).toBeNull()
  })

  it('unknown request id: expired message', async () => {
    api.getOAuthRequest.mockRejectedValue(Object.assign(new Error('x'), { status: 404 }))
    renderPage()
    await screen.findByText('oauthConsent.expiredText')
  })

  it('approve that races expiry (400 request_expired) shows the expired message', async () => {
    api.approveOAuthRequest.mockRejectedValue(Object.assign(new Error('request_expired'), { status: 400 }))
    renderPage()
    fireEvent.click(await screen.findByText('oauthConsent.allow'))
    await screen.findByText('oauthConsent.expiredText')
  })

  it('not signed in: sign-in prompt opens the auth modal, keeps the host visible', async () => {
    Object.assign(auth, { user: null, isAuthenticated: false })
    renderPage()
    fireEvent.click(await screen.findByText('oauthConsent.signIn'))
    expect(auth.openAuthModal).toHaveBeenCalled()
    expect(screen.getByText('claude.ai')).toBeTruthy()
    expect(api.approveOAuthRequest).not.toHaveBeenCalled()
  })

  it('switch signs out, then opens sign-in', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('(oauthConsent.switch)'))
    await waitFor(() => expect(auth.openAuthModal).toHaveBeenCalled())
    expect(auth.logout).toHaveBeenCalled()
  })
})
