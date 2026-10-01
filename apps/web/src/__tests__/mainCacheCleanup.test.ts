import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const clearExpiredCaches = vi.fn()
vi.mock('../lib/offlineDb', () => ({ clearExpiredCaches }))
vi.mock('react-dom/client', () => ({ default: { createRoot: () => ({ render: () => {} }) } }))
vi.mock('../App', () => ({ default: () => null }))

describe('main.tsx startup cache cleanup', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    clearExpiredCaches.mockReset()
    document.body.innerHTML = '<div id="root"></div>'
  })
  afterEach(() => vi.useRealTimers())

  it('runs once, after first paint', async () => {
    clearExpiredCaches.mockResolvedValue(undefined)
    await import('../main')
    expect(clearExpiredCaches).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(clearExpiredCaches).toHaveBeenCalledTimes(1)
  })

  it('swallows a failure (sync throw or rejection)', async () => {
    clearExpiredCaches.mockImplementation(() => { throw new Error('no IndexedDB') })
    await import('../main')
    expect(() => vi.runAllTimers()).not.toThrow()
  })
})
