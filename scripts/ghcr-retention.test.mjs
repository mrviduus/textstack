import { describe, it, expect } from 'vitest'
import { plan, deployedRefs, selectDeploys } from './ghcr-retention.mjs'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-07T00:00:00Z')
const sha = (n) => n.toString(16).padStart(40, '0')
const ver = (id, daysAgo, tags = [], name = `sha256:${id}`) => ({
  id,
  name,
  created_at: new Date(NOW - daysAgo * DAY).toISOString(),
  metadata: { container: { tags } },
})
const opts = (extra = {}) => ({ protectedShas: new Set(), now: NOW, keepNewest: 2, keepDays: 14, ...extra })
const ids = (xs) => xs.map((x) => (x.v ?? x).id)

describe('plan', () => {
  it('keeps the newest N tagged and anything younger than the window, deletes the rest oldest first', () => {
    const vs = [ver(1, 40, [sha(1)]), ver(2, 30, [sha(2)]), ver(3, 20, [sha(3)]), ver(4, 16, [sha(4)]), ver(5, 3, [sha(5)])]
    const { keep, del } = plan(vs, opts())
    expect(ids(keep)).toEqual([5, 4])
    expect(ids(del)).toEqual([1, 2, 3])
  })

  it('never deletes a deployed SHA, however old', () => {
    const vs = [ver(1, 90, [sha(1)]), ver(2, 30, [sha(2)]), ver(3, 20, [sha(3)]), ver(4, 16, [sha(4)])]
    const { keep, del } = plan(vs, opts({ protectedShas: new Set([sha(1)]) }))
    expect(keep.find((k) => k.v.id === 1).reasons).toEqual(['deployed'])
    expect(ids(del)).toEqual([2])
  })

  it('keeps a version with a tag that is not a commit SHA', () => {
    const vs = [ver(1, 90, ['latest']), ver(2, 30, [sha(2)]), ver(3, 20, [sha(3)])]
    expect(ids(plan(vs, opts()).del)).toEqual([])
  })

  it('untagged versions do not count toward the newest N', () => {
    const vs = [ver(1, 30, [sha(1)]), ver(2, 20, []), ver(3, 20, []), ver(4, 16, [sha(4)])]
    const { keep, del } = plan(vs, opts())
    expect(ids(keep)).toEqual([4, 1])
    expect(ids(del)).toEqual([2, 3])
  })

  it('keeps an old untagged manifest a kept index references, deletes an orphan', () => {
    const vs = [ver(1, 30, [sha(1)]), ver(2, 30, [], 'sha256:child'), ver(3, 30, [], 'sha256:orphan')]
    const { keep, del } = plan(vs, opts({ children: new Set(['sha256:child']) }))
    expect(keep.find((k) => k.v.id === 2).reasons).toEqual(['child'])
    expect(ids(del)).toEqual([3])
  })

  it('keeps a young untagged version (a push still in flight)', () => {
    expect(ids(plan([ver(1, 1, [])], opts()).del)).toEqual([])
  })

  it('orders deletions tagged before untagged, so an index goes before its manifests', () => {
    const vs = [ver(1, 50, []), ver(2, 40, [sha(2)]), ver(3, 30, [sha(3)]), ver(4, 20, [sha(4)]), ver(5, 15, [sha(5)])]
    expect(ids(plan(vs, opts()).del)).toEqual([2, 3, 1])
  })
})

describe('deployedRefs', () => {
  it('fails closed with no successful deploy', () => {
    expect(() => deployedRefs([], [])).toThrow(/refusing/)
  })

  it('takes head_sha, and the rollback target for a rollback run', () => {
    const refs = deployedRefs(
      [{ head_sha: sha(1), display_title: 'fix: x' }, { head_sha: sha(2), display_title: 'Rollback to abc1234' }],
      [{ head_sha: sha(3), display_title: 'feat: still running' }],
    )
    expect([...refs]).toEqual([sha(1), 'abc1234', sha(3)])
  })

  it('ignores a title that only looks like a rollback', () => {
    const refs = deployedRefs([{ head_sha: sha(1), display_title: 'Rollback to main; rm -rf' }], [])
    expect([...refs]).toEqual([sha(1)])
  })
})

describe('selectDeploys', () => {
  const run = (id, hoursAgo, conclusion) => ({ id, conclusion, created_at: new Date(NOW - hoursAgo * 3_600_000).toISOString() })

  it('sorts itself (API order is not trusted), takes the last N successes plus every run since', () => {
    const runs = [run(1, 50, 'success'), run(5, 1, null), run(3, 10, 'success'), run(4, 5, 'failure'), run(2, 20, 'success'), run(0, 60, 'failure')]
    const { ok, later } = selectDeploys(runs, 2)
    expect(ok.map((r) => r.id)).toEqual([3, 2])
    expect(later.map((r) => r.id)).toEqual([5, 4])
  })

  it('returns no successes when there are none', () => {
    expect(selectDeploys([run(1, 1, 'failure')], 5)).toEqual({ ok: [], later: [] })
  })
})
