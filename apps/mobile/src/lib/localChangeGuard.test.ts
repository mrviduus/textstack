import { describe, it, expect } from 'vitest'
import { createLocalChangeGuard } from './localChangeGuard'

describe('createLocalChangeGuard — a background refresh never overwrites a newer local change (review 2 #5)', () => {
  it('a refresh with no local change since it started may apply', () => {
    const g = createLocalChangeGuard()
    const t = g.begin()
    expect(g.mayApply(t)).toBe(true)
  })

  it('a tap (optimistic toggle, download-add) during the refresh makes its answer stale', () => {
    const g = createLocalChangeGuard()
    const t = g.begin()
    g.touch()
    expect(g.mayApply(t)).toBe(false)
  })

  it('a refresh started after the change applies again', () => {
    const g = createLocalChangeGuard()
    g.touch()
    const t = g.begin()
    expect(g.mayApply(t)).toBe(true)
  })

  it('while a write (add/remove POST) is in flight, no refresh applies — and not one started before it (review 4 #3)', async () => {
    const g = createLocalChangeGuard()
    const before = g.begin()
    let release!: () => void
    const write = g.track(new Promise<void>(r => { release = r }))
    const during = g.begin()
    expect(g.mayApply(before)).toBe(false)
    expect(g.mayApply(during)).toBe(false)
    release()
    await write
    expect(g.mayApply(during)).toBe(false)
    expect(g.mayApply(g.begin())).toBe(true)
  })

  it('a failed write still releases the guard', async () => {
    const g = createLocalChangeGuard()
    await g.track(Promise.reject(new Error('500'))).catch(() => {})
    expect(g.mayApply(g.begin())).toBe(true)
  })
})

