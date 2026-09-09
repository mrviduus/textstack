import { describe, it, expect } from 'vitest'
import { catalog } from '../catalog'
import golden from './__fixtures__/web-catalog.golden.json'

/**
 * Every string the web app can render, pinned by exact value — the MERGED catalogue,
 * so it covers the keys web inherits from shared as well as its own.
 *
 * This exists to make a refactor reviewable. The locale files are about to stop
 * being two copies and become one source plus an overlay, and the diff of that
 * move is 72 KB of relocated JSON — unreadable, and full of the kind of hazard
 * nobody catches by skimming: `palette.*` versus `library.palette.*`,
 * `library.sort.*` versus `library.sortRecent`, `tts.listen` versus
 * `home.features.tts`. So the fixture, not the diff, is the review surface: a
 * pure move leaves it untouched, and any line that does change is a production
 * copy change somebody has to defend.
 *
 * A committed fixture with an explicit compare, deliberately NOT
 * `toMatchFileSnapshot` — a snapshot is regenerated with one `vitest -u`, and the
 * entire point is that changing a shipped string should cost a hand edit.
 */
type Node = { [k: string]: string | string[] | Node }

function flatten(node: Node, prefix = '', out: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v as Node, path, out)
    else out[path] = v
  }
  return out
}

// The MERGED catalogue — what the app actually resolves — flattened by this test
// rather than by re-implementing the merge. A test that reimplements the thing it
// checks agrees with itself and nothing else.
const actual = flatten(catalog as Node)
const expected = golden as Record<string, unknown>

describe('web translation catalog', () => {
  it('resolves every pinned key to the same value', () => {
    const changed = Object.keys(expected).filter(k => actual[k] !== expected[k])
    // Named, not counted: a failure should say which string moved.
    expect(changed).toEqual([])
  })

  it('has not lost a key', () => {
    const missing = Object.keys(expected).filter(k => !(k in actual))
    expect(missing).toEqual([])
  })

  it('has not gained a key without the fixture being updated', () => {
    // The other direction matters too. A key added to the catalogue and never
    // added here is a string nobody reviewed — including one that arrives from
    // shared, which web can now resolve whether or not it renders it.
    const added = Object.keys(actual).filter(k => !(k in expected))
    expect(added).toEqual([])
  })
})
