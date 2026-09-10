import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

// vi.mock is hoisted above every top-level binding, so the fakes have to be created inside
// vi.hoisted rather than as plain consts — otherwise the factory runs before they exist.
const { auth, api } = vi.hoisted(() => ({
  auth: { isAuthenticated: true, openAuthModal: () => {} },
  api: { listMcpKeys: vi.fn(), createMcpKey: vi.fn(), revokeMcpKey: vi.fn() },
}))

vi.mock('../../../context/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../../../api/mcpKeys', async () => {
  const actual = await vi.importActual<typeof import('../../../api/mcpKeys')>('../../../api/mcpKeys')
  return { ...actual, ...api }
})

import { ConnectAssistant } from '../ConnectAssistant'

const KEY = 'tsk_abcdefghijklmnopqrstuvwxyz0123456789ABCDE'

const listed = (over: Partial<{ id: string; lastUsedAt: string | null; revokedAt: string | null }> = {}) => ({
  id: 'k1',
  name: 'Assistant · 2026-09-10',
  prefix: 'tsk_abcdef',
  createdAt: '2026-09-10T00:00:00Z',
  lastUsedAt: null,
  revokedAt: null,
  ...over,
})

beforeEach(() => {
  auth.isAuthenticated = true
  api.listMcpKeys.mockReset().mockResolvedValue([])
  api.createMcpKey.mockReset()
  api.revokeMcpKey.mockReset().mockResolvedValue(undefined)
})
afterEach(() => cleanup())

describe('ConnectAssistant', () => {
  it('asks a signed-out reader to sign in and never calls the API', async () => {
    auth.isAuthenticated = false
    render(<ConnectAssistant />)

    expect(screen.getByText('mcp.connect.signInCta')).toBeTruthy()
    // A key is per-account; listing before there is an account is a guaranteed 401.
    expect(api.listMcpKeys).not.toHaveBeenCalled()
  })

  it('shows the secret exactly once, and only after it is created', async () => {
    api.createMcpKey.mockResolvedValue({
      id: 'k1', name: 'n', key: KEY, prefix: 'tsk_abcdef', createdAt: '2026-09-10T00:00:00Z',
    })
    api.listMcpKeys.mockResolvedValue([listed()])

    render(<ConnectAssistant />)
    // Nothing secret on screen before the reader asks for it.
    await waitFor(() => expect(api.listMcpKeys).toHaveBeenCalled())
    expect(screen.queryByText(KEY)).toBeNull()

    fireEvent.click(screen.getByText('mcp.connect.createCta'))

    await waitFor(() => expect(screen.getByText(KEY)).toBeTruthy())
    // The server keeps only a hash, so the warning is a statement of fact and must be present.
    expect(screen.getByText('mcp.connect.shownOnce')).toBeTruthy()
  })

  it('puts the key into a ready-to-paste connector config', async () => {
    api.createMcpKey.mockResolvedValue({
      id: 'k1', name: 'n', key: KEY, prefix: 'tsk_abcdef', createdAt: '2026-09-10T00:00:00Z',
    })
    api.listMcpKeys.mockResolvedValue([listed()])

    render(<ConnectAssistant />)
    fireEvent.click(screen.getByText('mcp.connect.createCta'))

    // The whole point: copy from here, paste into the client. A config the reader has to hand-edit
    // to insert the key is the terminal step this feature exists to remove.
    const config = await screen.findByText(/mcpServers/)
    expect(config.textContent).toContain(KEY)
    expect(config.textContent).toContain('https://textstack.app/mcp')
  })

  it('stops showing a secret the moment its key is revoked', async () => {
    api.createMcpKey.mockResolvedValue({
      id: 'k1', name: 'n', key: KEY, prefix: 'tsk_abcdef', createdAt: '2026-09-10T00:00:00Z',
    })
    api.listMcpKeys.mockResolvedValue([listed()])

    render(<ConnectAssistant />)
    fireEvent.click(screen.getByText('mcp.connect.createCta'))
    await waitFor(() => expect(screen.getByText(KEY)).toBeTruthy())

    api.listMcpKeys.mockResolvedValue([])
    fireEvent.click(screen.getByText('mcp.connect.revoke'))

    // Leaving a revoked key on screen invites pasting a string that authenticates nothing.
    await waitFor(() => expect(screen.queryByText(KEY)).toBeNull())
    expect(api.revokeMcpKey).toHaveBeenCalledWith('k1')
  })

  it('hides revoked keys from the list but keeps live ones', async () => {
    api.listMcpKeys.mockResolvedValue([
      listed({ id: 'live' }),
      listed({ id: 'dead', revokedAt: '2026-09-10T01:00:00Z' }),
    ])

    render(<ConnectAssistant />)
    await waitFor(() => expect(screen.getAllByText('mcp.connect.revoke').length).toBe(1))
  })

  it('says whether a key has ever been used — the only signal that a connector works', async () => {
    api.listMcpKeys.mockResolvedValue([listed({ lastUsedAt: null })])
    render(<ConnectAssistant />)
    await waitFor(() => expect(screen.getByText('mcp.connect.neverUsed')).toBeTruthy())

    cleanup()
    api.listMcpKeys.mockResolvedValue([listed({ lastUsedAt: '2026-09-10T02:00:00Z' })])
    render(<ConnectAssistant />)
    await waitFor(() => expect(screen.getByText('mcp.connect.usedRecently')).toBeTruthy())
  })

  it('surfaces a failed create instead of silently doing nothing', async () => {
    api.listMcpKeys.mockResolvedValue([])
    api.createMcpKey.mockRejectedValue(new Error('boom'))

    render(<ConnectAssistant />)
    fireEvent.click(screen.getByText('mcp.connect.createCta'))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('boom'))
  })
})
