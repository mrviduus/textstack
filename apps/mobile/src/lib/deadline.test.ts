import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { withDeadline } from './deadline'

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')

describe('withDeadline', () => {
  // A test that fails on fake timers must not leave them to the next one.
  afterEach(() => { vi.useRealTimers() })

  it('QA-007: one deadline helper for the library/resume waits; SessionGate keeps its mount timer', async () => {
    vi.useFakeTimers()
    const late = withDeadline(new Promise(() => {}), 3000)
    const caught = late.catch(e => e.message)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await caught).toBe('deadline')
    vi.useRealTimers()
    expect(await withDeadline(Promise.resolve(7), 10)).toBe(7)
    await expect(withDeadline(Promise.reject(new Error('x')), 10)).rejects.toThrow('x')
    // SessionGate keeps its own mount-time timer on purpose: it must also open the gate while the
    // SecureStore bootstrap is wedged, when ensureSession has already answered 'skipped'.
    expect(read('src/components/SessionGate.tsx')).toMatch(/setTimeout\(/)
  })
})
