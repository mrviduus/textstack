import { describe, it, expect } from 'vitest'
import { decide, merge, runtimeOf } from './mobile-ota-decide.mjs'

// Shaped like a real `eas build:list --json` record (runtime/updateChannel are objects).
let n = 0
const build = (status, rt, extra = {}) => ({
  id: `b${++n}`,
  status,
  buildProfile: 'production',
  updateChannel: { id: 'c', name: 'production' },
  runtime: { id: 'r', version: rt },
  fingerprint: { id: 'f', hash: rt },
  createdAt: new Date(Date.UTC(2026, 9, n)).toISOString(),
  ...extra,
})

describe('decide', () => {
  it('publishes when the runtime matches the newest finished production build', () => {
    const old = build('FINISHED', 'aaa')
    const r = decide([old], 'aaa')
    expect(r.action).toBe('publish')
    expect(r.installed.id).toBe(old.id)
  })

  it('builds when the runtime moved and nothing is in flight', () => {
    expect(decide([build('FINISHED', 'aaa')], 'bbb').action).toBe('build')
  })

  it('does not build twice: a queued/running build of this runtime means queued', () => {
    for (const s of ['NEW', 'IN_QUEUE', 'IN_PROGRESS']) {
      const inflight = build(s, 'bbb')
      const r = decide([inflight, build('FINISHED', 'aaa')], 'bbb')
      expect(r.action).toBe('queued')
      expect(r.inflight.id).toBe(inflight.id)
      expect(r.runtime).toBe('aaa')
    }
  })

  it('builds again when the in-flight build has another runtime, or errored/was canceled', () => {
    expect(decide([build('IN_QUEUE', 'ccc'), build('FINISHED', 'aaa')], 'bbb').action).toBe('build')
    expect(decide([build('ERRORED', 'bbb'), build('FINISHED', 'aaa')], 'bbb').action).toBe('build')
    expect(decide([build('CANCELED', 'bbb'), build('FINISHED', 'aaa')], 'bbb').action).toBe('build')
  })

  it('once the new build finishes, the next push publishes against it', () => {
    const r = decide([build('FINISHED', 'aaa'), build('FINISHED', 'bbb')], 'bbb')
    expect(r.action).toBe('publish')
    expect(r.runtime).toBe('bbb')
  })

  it('publishes when the installed build matches, whatever is in flight', () => {
    expect(decide([build('FINISHED', 'aaa'), build('IN_PROGRESS', 'zzz')], 'aaa').action).toBe('publish')
  })

  it('picks the newest finished build by createdAt, not list order', () => {
    const newer = build('FINISHED', 'bbb')
    const older = build('FINISHED', 'aaa', { createdAt: '2020-01-01T00:00:00Z' })
    expect(decide([older, newer], 'bbb').installed.id).toBe(newer.id)
  })

  it('ignores other profiles and channels', () => {
    const preview = build('FINISHED', 'bbb', { buildProfile: 'preview', updateChannel: { name: 'preview' } })
    expect(decide([preview, build('FINISHED', 'aaa')], 'bbb').action).toBe('build')
    expect(decide([preview], 'bbb').error).toBe('no-build')
  })

  it('errors on no finished build, and on one without a runtime', () => {
    expect(decide([], 'aaa').error).toBe('no-build')
    expect(decide([build('IN_QUEUE', 'aaa')], 'aaa').error).toBe('no-build')
    expect(decide([build('FINISHED', '', { fingerprint: null })], 'aaa').error).toBe('no-runtime')
  })
})

describe('merge', () => {
  it('concatenates per-status listings, drops duplicate ids, and decides over the result', () => {
    const finished = [build('FINISHED', 'aaa')]
    const queued = build('IN_QUEUE', 'bbb')
    const builds = merge(finished, [queued], [], [queued])
    expect(builds.map((b) => b.id)).toEqual([finished[0].id, queued.id])
    expect(decide(builds, 'bbb').action).toBe('queued')
  })

  it('finds the finished build however many builds of other statuses are newer', () => {
    // The single --limit 50 window over all statuses could miss it; per-status listings cannot.
    const noise = Array.from({ length: 60 }, () => build('ERRORED', 'zzz'))
    const finished = build('FINISHED', 'aaa', { createdAt: '2020-01-01T00:00:00Z' })
    expect(decide(merge([finished], noise), 'aaa').action).toBe('publish')
  })
})

describe('runtimeOf', () => {
  it('reads object, string and fingerprint fallbacks', () => {
    expect(runtimeOf({ runtime: { version: 'x' } })).toBe('x')
    expect(runtimeOf({ runtime: 'y' })).toBe('y')
    expect(runtimeOf({ runtimeVersion: 'z' })).toBe('z')
    expect(runtimeOf({ fingerprint: { hash: 'h' } })).toBe('h')
    expect(runtimeOf({})).toBe('')
  })
})
