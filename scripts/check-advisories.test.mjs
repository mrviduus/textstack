import { describe, it, expect } from 'vitest'
import {
  readInstalled,
  strayLockfiles,
  advisoryId,
  classify,
  chunk,
  fetchAdvisories,
  LookupFailed,
  BATCH_SIZE,
} from './check-advisories.mjs'

// A lockfile in miniature, carrying every shape the real one has: quoted and
// bare keys, a scoped name, two versions of one package, and a `snapshots:`
// section underneath whose peer-suffixed keys must not be mistaken for packages.
const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  apps/web:
    dependencies:
      react:
        specifier: catalog:
        version: 19.2.3

packages:

  '@types/react@19.2.18':
    resolution: {integrity: sha512-aaa}

  accepts@1.3.8:
    resolution: {integrity: sha512-bbb}

  accepts@2.0.0:
    resolution: {integrity: sha512-ccc}

  uuid@7.0.3:
    resolution: {integrity: sha512-ddd}

snapshots:

  '@types/react@19.2.18':
    dependencies:
      csstype: 3.2.3

  react-dom@19.2.3(react@19.2.3):
    dependencies:
      react: 19.2.3
`

describe('readInstalled', () => {
  const installed = readInstalled(LOCK)

  it('takes every package key, quoted or not, scoped or not', () => {
    expect(installed['@types/react']).toEqual(['19.2.18'])
    expect(installed['uuid']).toEqual(['7.0.3'])
  })

  it('keeps both versions when a package is installed twice', () => {
    // The registry filters by version, so sending only one of them would hide a
    // vulnerable copy behind a safe one.
    expect(installed['accepts']).toEqual(['1.3.8', '2.0.0'])
  })

  it('stops at the end of the packages block', () => {
    // `react-dom@19.2.3(react@19.2.3)` lives in `snapshots:`. Reading past the
    // block would invent a package name with a peer suffix in it, and the
    // registry would answer about something that does not exist.
    expect(Object.keys(installed)).not.toContain('react-dom')
    expect(Object.keys(installed).some((n) => n.includes('('))).toBe(false)
  })

  it('ignores the importers block above it', () => {
    expect(Object.keys(installed)).not.toContain('apps/web')
    expect(Object.keys(installed)).toEqual(['@types/react', 'accepts', 'uuid'])
  })

  it('yields nothing rather than guessing when the format moves', () => {
    // The safe direction to fail in: the caller turns an empty result into
    // COULD NOT CHECK instead of into a clean tree.
    expect(readInstalled('lockfileVersion: 9.0\n\nsnapshots:\n  foo@1.0.0: {}\n')).toEqual({})
  })
})

describe('advisoryId', () => {
  it('pulls the GHSA id out of the advisory URL', () => {
    expect(advisoryId('https://github.com/advisories/GHSA-w5hq-g745-h8pq')).toBe('GHSA-w5hq-g745-h8pq')
    expect(advisoryId('https://github.com/advisories/GHSA-w5hq-g745-h8pq/')).toBe('GHSA-w5hq-g745-h8pq')
  })

  it('answers null rather than something wrong', () => {
    expect(advisoryId('https://example.com/nope')).toBeNull()
    expect(advisoryId(undefined)).toBeNull()
  })
})

const known = {
  'GHSA-aaaa-aaaa-aaaa': { since: '2026-01-01', module: 'left-pad', needs: '>=1', why: 'test' },
}
const advisory = (id, module = 'left-pad') => ({
  url: `https://github.com/advisories/${id}`,
  id,
  module_name: module,
  severity: 'moderate',
  title: 't',
  vulnerable_versions: '<1',
})

describe('classify', () => {
  it('says clean when every finding is written down', () => {
    const { unknown, stale } = classify([advisory('GHSA-aaaa-aaaa-aaaa')], known)
    expect(unknown).toEqual([])
    expect(stale).toEqual([])
  })

  it('surfaces a finding nobody wrote down', () => {
    const { unknown, stale } = classify(
      [advisory('GHSA-aaaa-aaaa-aaaa'), advisory('GHSA-bbbb-bbbb-bbbb', 'right-pad')],
      known,
    )
    expect(unknown.map((a) => a.id)).toEqual(['GHSA-bbbb-bbbb-bbbb'])
    expect(stale).toEqual([])
  })

  it('surfaces an entry that stopped being reported', () => {
    const { unknown, stale } = classify([], known)
    expect(unknown).toEqual([])
    expect(stale).toEqual(['GHSA-aaaa-aaaa-aaaa'])
  })

  it('treats an advisory with no usable id as unlisted, not as known', () => {
    const { unknown } = classify([{ url: 'https://example.com/x', id: null, module_name: 'x' }], known)
    expect(unknown).toHaveLength(1)
  })
})

describe('fetchAdvisories', () => {
  const ok = (payload) => async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => payload })

  it('returns what the registry reports, with the name and id attached', async () => {
    const found = await fetchAdvisories(
      { uuid: ['7.0.3'] },
      { fetchImpl: ok({ uuid: [{ url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq', severity: 'moderate' }] }) },
    )
    expect(found).toHaveLength(1)
    expect(found[0].module_name).toBe('uuid')
    expect(found[0].id).toBe('GHSA-w5hq-g745-h8pq')
  })

  it('treats an empty lockfile reading as no verdict, not as a clean tree', async () => {
    await expect(fetchAdvisories({}, { fetchImpl: ok({}) })).rejects.toBeInstanceOf(LookupFailed)
  })

  it('treats a refusing registry as no verdict', async () => {
    const failing = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' })
    await expect(fetchAdvisories({ uuid: ['7.0.3'] }, { fetchImpl: failing, retries: 1 }))
      .rejects.toBeInstanceOf(LookupFailed)
  })

  it('treats a body of the wrong shape as no verdict', async () => {
    // A 200 carrying something that is not an advisory map used to be the
    // subtlest failure of all: well-formed, empty, and indistinguishable from
    // good news.
    await expect(fetchAdvisories({ uuid: ['7.0.3'] }, { fetchImpl: ok([]) }))
      .rejects.toBeInstanceOf(LookupFailed)
  })

  it('retries once before giving up', async () => {
    let calls = 0
    const flaky = async () => {
      calls++
      if (calls === 1) throw new Error('socket hang up')
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) }
    }
    await expect(fetchAdvisories({ uuid: ['7.0.3'] }, { fetchImpl: flaky })).resolves.toEqual([])
    expect(calls).toBe(2)
  })

  it('splits a large tree into batches instead of one enormous body', async () => {
    const installed = {}
    for (let i = 0; i < BATCH_SIZE * 2 + 1; i++) installed[`pkg-${i}`] = ['1.0.0']
    let calls = 0
    const counting = async () => {
      calls++
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) }
    }
    await fetchAdvisories(installed, { fetchImpl: counting })
    expect(calls).toBe(3)
  })
})

describe('chunk', () => {
  it('splits without losing or duplicating anything', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
  })
})

describe('strayLockfiles', () => {
  it('lists a second lockfile and never the root one', () => {
    const run = () => 'pnpm-lock.yaml\npackages/shared/pnpm-lock.yaml\napps/web/package-lock.json\n'
    expect(strayLockfiles({ run })).toEqual(['packages/shared/pnpm-lock.yaml', 'apps/web/package-lock.json'])
  })

  it('reports a git that cannot answer as no verdict, not as no strays', () => {
    // Found by accident, running this script from outside a checkout: it threw
    // an uncaught error. "git could not answer" is not "there are no stray
    // lockfiles", and folding those together is the exact mistake this rewrite
    // exists to remove.
    const run = () => { throw new Error('not a git repository') }
    expect(() => strayLockfiles({ run })).toThrow(LookupFailed)
  })
})
