import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const { auth, api } = vi.hoisted(() => ({
  auth: { isAuthenticated: true },
  api: { listOAuthGrants: vi.fn(), revokeOAuthGrant: vi.fn() },
}))
vi.mock('../../../context/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../../../api/oauth', () => api)

import { ConnectedApps } from '../ConnectedApps'

const grant = (id: string, clientName: string, lastUsedAt: string | null = null) => ({
  id, clientName, redirectHost: `${clientName.toLowerCase()}.ai`, createdAt: '2026-09-29T00:00:00Z', lastUsedAt,
})

beforeEach(() => {
  auth.isAuthenticated = true
  api.listOAuthGrants.mockReset().mockResolvedValue([grant('g1', 'Claude'), grant('g2', 'ChatGPT', '2026-09-29T01:00:00Z')])
  api.revokeOAuthGrant.mockReset().mockResolvedValue(undefined)
})
afterEach(() => cleanup())

describe('ConnectedApps', () => {
  it('renders nothing and calls nothing when signed out', () => {
    auth.isAuthenticated = false
    const { container } = render(<ConnectedApps />)
    expect(container.innerHTML).toBe('')
    expect(api.listOAuthGrants).not.toHaveBeenCalled()
  })

  it('lists grants with their redirect host', async () => {
    render(<ConnectedApps />)
    await screen.findByText('Claude')
    expect(screen.getByText('claude.ai')).toBeTruthy()
    expect(screen.getByText('chatgpt.ai')).toBeTruthy()
  })

  it('Disconnect revokes and removes only that row', async () => {
    render(<ConnectedApps />)
    await screen.findByText('Claude')
    fireEvent.click(screen.getAllByText('connect.apps.disconnect')[0])
    // 3s, not the 1s default: on a loaded CI runner this took 1035ms and failed a deploy (2026-10-01).
    await waitFor(() => expect(screen.queryByText('Claude')).toBeNull(), { timeout: 3000 })
    expect(api.revokeOAuthGrant).toHaveBeenCalledWith('g1')
    expect(screen.getByText('ChatGPT')).toBeTruthy()
  })

  it('keeps the row and says so when disconnect fails', async () => {
    api.revokeOAuthGrant.mockRejectedValue(new Error('x'))
    render(<ConnectedApps />)
    await screen.findByText('Claude')
    fireEvent.click(screen.getAllByText('connect.apps.disconnect')[0])
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('connect.apps.disconnectFailed'))
    expect(screen.getByText('Claude')).toBeTruthy()
  })

  it('empty state', async () => {
    api.listOAuthGrants.mockResolvedValue([])
    render(<ConnectedApps />)
    await screen.findByText('connect.apps.empty')
  })
})
