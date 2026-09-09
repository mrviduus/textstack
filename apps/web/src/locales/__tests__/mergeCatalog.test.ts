import { describe, it, expect } from 'vitest'
import { translations as shared } from '@textstack/shared'
import { mergeCatalog, catalog, type TranslationNode } from '../catalog'

/**
 * The merge itself. Small surface, but three of these five properties are the kind
 * that pass in isolation and cause damage somewhere else.
 */
describe('mergeCatalog', () => {
  it('takes the right-hand value at a leaf — an override is a decision', () => {
    const out = mergeCatalog({ a: 'shared' }, { a: 'web' })
    expect(out.a).toBe('web')
  })

  it('merges deeply instead of replacing a whole subtree', () => {
    // The failure this prevents: web overriding one string under `library.sort`
    // and silently deleting every sibling it did not mention.
    const out = mergeCatalog(
      { library: { sort: { a: 'A', b: 'B' } } },
      { library: { sort: { b: 'B2' } } },
    ) as { library: { sort: Record<string, string> } }
    expect(out.library.sort).toEqual({ a: 'A', b: 'B2' })
  })

  it('does not mutate either input', () => {
    // The important one. Mutating the shared catalogue would change it for every
    // other importer in the process — the shared package's own t(), and under
    // vitest every other test file in the same worker. That is a merge that
    // passes its own tests and corrupts somebody else's.
    const base: TranslationNode = { keep: 'me', nested: { x: '1' } }
    const over: TranslationNode = { nested: { x: '2' }, extra: 'new' }
    const baseCopy = structuredClone(base)
    const overCopy = structuredClone(over)

    mergeCatalog(base, over)

    expect(base).toEqual(baseCopy)
    expect(over).toEqual(overCopy)
  })

  it('replaces arrays rather than concatenating them', () => {
    const out = mergeCatalog({ points: ['a', 'b'] }, { points: ['c'] })
    expect(out.points).toEqual(['c'])
  })

  it('refuses a string-vs-object collision instead of picking one', () => {
    // No correct answer exists: the result would depend on read order and the
    // loser's subtree would vanish without a word. The message names the path.
    expect(() => mergeCatalog({ a: { b: 'x' } }, { a: 'flat' })).toThrow(/collision at "a"/)
    expect(() => mergeCatalog({ a: 'flat' }, { a: { b: 'x' } })).toThrow(/collision at "a"/)
  })

  it('reports the full path of a nested collision', () => {
    expect(() => mergeCatalog({ a: { b: { c: 'x' } } }, { a: { b: 'flat' } }))
      .toThrow(/collision at "a\.b"/)
  })
})

describe('the real catalogue', () => {
  it('builds without a collision', () => {
    expect(Object.keys(catalog).length).toBeGreaterThan(30)
  })

  it('left the shared catalogue untouched', () => {
    // Guards the same hazard as the unit test above, but against the real module
    // graph: if `catalog.ts` ever mutates on merge, this is what notices.
    expect((shared.en as TranslationNode).common).not.toHaveProperty('__merged')
    const sharedCommon = (shared.en as TranslationNode).common as TranslationNode
    const mergedCommon = catalog.common as TranslationNode
    expect(mergedCommon).not.toBe(sharedCommon)
  })
})
