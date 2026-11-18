import { describe, it, expect } from 'vitest'
import { plan, deployedRefs, selectDeploys, uniqueRuns, checkLive, newestSuccess, findDeployByCommit } from './ghcr-retention.mjs'

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

  it('fails closed with fewer successful deploys than asked for', () => {
    expect(() => selectDeploys([run(1, 1, 'failure'), run(2, 2, 'success')], 2)).toThrow(/only 1 successful/)
  })

  it('orders by run_started_at, so a re-run of an old rollback counts as recent', () => {
    const rerun = { ...run(9, 200, 'success'), run_started_at: new Date(NOW - 1 * 3_600_000).toISOString(), display_title: 'Rollback to abc1234' }
    const { ok } = selectDeploys([run(1, 5, 'success'), run(2, 10, 'success'), rerun], 2)
    expect(ok.map((r) => r.id)).toEqual([9, 1])
  })

  it('falls back to updated_at, then created_at', () => {
    const upd = { ...run(3, 100, 'success'), updated_at: new Date(NOW).toISOString() }
    expect(selectDeploys([run(1, 5, 'success'), upd], 1).ok.map((r) => r.id)).toEqual([3])
  })
})

describe('uniqueRuns', () => {
  it('drops a run seen on both pages', () => {
    expect(uniqueRuns([{ id: 1 }, { id: 2 }, { id: 1 }], 2).map((r) => r.id)).toEqual([1, 2])
  })

  it('fails closed when a duplicate hides a missing run', () => {
    // total 3, three rows returned, but run 3 never arrived and run 1 came twice
    expect(() => uniqueRuns([{ id: 1 }, { id: 2 }, { id: 1 }], 3)).toThrow(/2 unique of 3/)
  })
})

describe('checkLive', () => {
  // 2026-10-07 20:20, GITHUB_TOKEN: the listing was self-consistent (unique == total_count) but its
  // newest successful deploy was 2026-10-03; the live 2026-10-07 deploy was not in it.
  const listing = [{ id: 37144301649, head_sha: sha(1) }, { id: 37143995310, head_sha: sha(2) }]

  it('fails closed when the live deploy is missing from the listing', () => {
    expect(() => checkLive(listing, { id: 37699392330, head_sha: sha(9) })).toThrow(/not in the protected set/)
  })

  it('fails closed when no live deploy was found', () => {
    expect(() => checkLive(listing, null)).toThrow(/none found/)
  })

  it('passes when the listing holds the live deploy', () => {
    expect(checkLive(listing, { id: 37144301649 }).id).toBe(37144301649)
  })

  it('returns the re-run of an old rollback as live when it started after the commit-order deploy', () => {
    // ok is sorted by run_started_at: the re-run (old head_sha) sorts above the newest commit's deploy
    const ok = [{ id: 7, head_sha: sha(1), display_title: 'Rollback to abc1234' }, { id: 8, head_sha: sha(5) }]
    expect(checkLive(ok, { id: 8, head_sha: sha(5) }).id).toBe(7)
  })
})

describe('findDeployByCommit', () => {
  const SINCE = NOW - 30 * DAY
  // 250 commits, newest first, one hour apart; only `deployed` has a successful deploy run
  const commits = Array.from({ length: 250 }, (_, i) => ({ sha: sha(i + 1), commit: { committer: { date: new Date(NOW - i * 3_600_000).toISOString() } } }))
  const pages = (page) => Promise.resolve(commits.slice((page - 1) * 100, page * 100))
  const runsOf = (deployed) => (s) => Promise.resolve(s === deployed ? [{ id: 1, conclusion: 'success', head_branch: 'main' }] : [])

  it('pages past 100 commits that deploy.yml skipped (docs, mobile) to the newest deploy', async () => {
    expect((await findDeployByCommit(pages, runsOf(sha(150)), SINCE)).id).toBe(1)
  })

  it('is null when no commit inside the window has a deploy', async () => {
    expect(await findDeployByCommit(pages, runsOf(sha(150)), NOW - 100 * 3_600_000)).toBeNull()
  })
})

describe('newestSuccess', () => {
  const r = (id, conclusion, hoursAgo, head_branch = 'main') => ({ id, conclusion, head_branch, run_started_at: new Date(NOW - hoursAgo * 3_600_000).toISOString() })

  it('takes the newest successful main run of a commit (a rollback dispatched after its push deploy)', () => {
    expect(newestSuccess([r(1, 'success', 5), r(2, 'success', 1), r(3, 'failure', 0), r(4, 'success', 0, 'feature')]).id).toBe(2)
  })

  it('is null when the commit has no successful deploy on main', () => {
    expect(newestSuccess([r(1, 'failure', 1)])).toBeNull()
  })
})
