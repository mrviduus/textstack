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
})
