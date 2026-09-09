import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import golden from './__fixtures__/shared-catalog.golden.json'

/**
 * Every string the mobile app can render, pinned by exact value. The twin of
 * `apps/web/src/locales/__tests__/golden.test.ts`, and the more important half.
 *
 * `packages/shared/src/i18n/en.json` is about to become the single source for
 * strings both apps use, which means it will be edited for the WEB app's benefit.
 * And `mobile-ota.yml` triggers on `paths: packages/**` — i18n is plain JS and does
 * not move the Expo fingerprint, so a merge to main republishes the bundle to
 * installed Android phones with no store review and nobody pressing anything.
 *
 * This fixture is what stands between "we tidied the shared file" and "an OTA
 * silently changed the copy on someone's phone".
 *
 * Lives in `src/lib/` because `apps/mobile/vitest.config.ts` sets
 * `include: ['src/lib/**\/*.test.ts']` — a test anywhere else in this app does not run.
 */
const CATALOG = resolve(__dirname, '../../../../packages/shared/src/i18n/en.json')

type Node = { [k: string]: string | string[] | Node }

function flatten(node: Node, prefix = '', out: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v as Node, path, out)
    else out[path] = v
  }
  return out
}

const actual = flatten(JSON.parse(readFileSync(CATALOG, 'utf8')))
const expected = golden as Record<string, unknown>

describe('shared translation catalog', () => {
  it('resolves every pinned key to the same value', () => {
    expect(Object.keys(expected).filter(k => actual[k] !== expected[k])).toEqual([])
  })

  it('has not lost a key', () => {
    expect(Object.keys(expected).filter(k => !(k in actual))).toEqual([])
  })

  it('has not gained a key without the fixture being updated', () => {
    expect(Object.keys(actual).filter(k => !(k in expected))).toEqual([])
  })
})
