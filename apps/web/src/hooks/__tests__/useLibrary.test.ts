import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'

const getLibraryMock = vi.fn()

vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }))
vi.mock('../../context/DownloadContext', () => ({
  useDownload: () => ({ startDownload: vi.fn(), cancelDownload: vi.fn() }),
}))
vi.mock('../../context/LanguageContext', () => ({ useLanguage: () => ({ language: 'en' }) }))
vi.mock('../../api/auth', () => ({
  getLibrary: () => getLibraryMock(),
  addToLibrary: vi.fn(),
  removeFromLibrary: vi.fn(),
}))
vi.mock('../../lib/offlineDb', () => ({ deleteAllCachedData: vi.fn() }))

import { useLibrary } from '../useLibrary'

describe('useLibrary', () => {
  afterEach(() => { cleanup(); getLibraryMock.mockReset() })

  it('loads /me/library by default', async () => {
    getLibraryMock.mockResolvedValue({ items: [] })
    renderHook(() => useLibrary())
    await waitFor(() => expect(getLibraryMock).toHaveBeenCalled())
  })

  // Reader on an upload: /me/library holds editions only, so loading it is waste.
  it('does not load or add when disabled', async () => {
    const { result } = renderHook(() => useLibrary({ enabled: false }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(getLibraryMock).not.toHaveBeenCalled()
    expect(await result.current.add('ub-1')).toBeUndefined()
  })
})
