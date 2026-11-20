// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '../test/renderHook'

const mocks = vi.hoisted(() => ({
  grants: vi.fn(), remembered: vi.fn(), open: vi.fn(), alert: vi.fn(), toast: vi.fn(),
}))
vi.mock('react-native', () => ({ Linking: { openURL: mocks.open }, Alert: { alert: mocks.alert } }))
vi.mock('../context/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock('../context/ToastContext', () => ({ useToast: () => ({ show: mocks.toast }) }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: {} }) }))
vi.mock('../lib/capabilities', () => ({ capabilitiesFor: () => ({ canConnectAssistant: true }) }))
vi.mock('../lib/chapterReviewLaunch', () => ({
  loadGrantsCached: mocks.grants, loadReviewAssistant: mocks.remembered,
  saveReviewAssistant: vi.fn(), resetGrantsCache: vi.fn(),
}))
import { useAssistantLauncher } from './useAssistantLauncher'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.grants.mockResolvedValue([])
  mocks.remembered.mockResolvedValue(null)
  mocks.open.mockResolvedValue(undefined)
})

describe('Discuss launcher', () => {
  it('opens ChatGPT with the book brief instead of connection instructions', async () => {
    const h = renderHook(() => useAssistantLauncher({ eager: false }), {})
    await act(async () => { await h.result.current.launch(() => 'Discuss Dracula') })
    expect(mocks.open).toHaveBeenCalledWith('https://chatgpt.com/?q=Discuss%20Dracula')
    expect(h.result.current.connect).toBe(false)
    expect(mocks.alert).not.toHaveBeenCalled()
    h.unmount()
  })

  it('keeps a remembered assistant without OAuth discovery', async () => {
    mocks.remembered.mockResolvedValue('claude')
    const h = renderHook(() => useAssistantLauncher({ eager: false }), {})
    await act(async () => { await h.result.current.launch(() => 'Discuss Dracula') })
    expect(mocks.open).toHaveBeenCalledWith('https://claude.ai/new?q=Discuss%20Dracula')
    h.unmount()
  })
})
