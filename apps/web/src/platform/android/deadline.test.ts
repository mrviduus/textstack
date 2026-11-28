import { describe, it, expect, vi, afterEach } from 'vitest'
import { withDeadline } from './deadline'

describe('withDeadline', () => {
  // A test that fails on fake timers must not leave them to the next one.
  afterEach(() => { vi.useRealTimers() })

  it('QA-007: one deadline helper for the library/resume waits', async () => {
    vi.useFakeTimers()
    const late = withDeadline(new Promise(() => {}), 3000)
    const caught = late.catch(e => e.message)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await caught).toBe('deadline')
    vi.useRealTimers()
    expect(await withDeadline(Promise.resolve(7), 10)).toBe(7)
    await expect(withDeadline(Promise.reject(new Error('x')), 10)).rejects.toThrow('x')
  })
})
