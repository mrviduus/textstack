import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The register of strings web deliberately says differently from the app.
 *
 * The two catalogues used to hold 547 of the same key paths, 523 identical and 24
 * quietly diverged, and nothing compared them. Shared is the source now and web is
 * an overlay, so the only way a string can exist twice is if somebody chose that —
 * and this test is where the choice has to be written down.
 *
 * The assertion is **set equality**, not "no unexpected overrides". Equality also
 * fails when an override is removed or its reason stops applying, which keeps the
 * list honest instead of letting it accumulate.
 *
 * The reasons live here rather than beside the strings because JSON has no
 * comments, and a reason nothing enforces is not a reason.
 */
const web = JSON.parse(readFileSync(resolve(__dirname, '../en.json'), 'utf8'))
const shared = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../packages/shared/src/i18n/en.json'), 'utf8'),
)

const OVERRIDES: Record<string, string> = {
  'contact.responseBody':
    'Brand. The website is "TextStack Reader" (index.html, the manifest, SeoHead, the ' +
    'JSON-LD); the app is "TextStack" (app.json). Each names itself.',

  'library.actions.addToCollectionEmpty':
    'Different affordance in view: web points at the sidebar, mobile at a sheet below.',

  'library.collections.new':
    'Mobile bakes a "+" into the copy where web renders an icon. A smell worth fixing on ' +
    'the mobile side — until it is, the two really do differ.',

  'library.sort.added':   'Short labels for a phone; both reached via t(`library.sort.${key}`).',
  'library.sort.progress': 'Short labels for a phone; both reached via t(`library.sort.${key}`).',
  'library.sort.recent':  'Short labels for a phone; both reached via t(`library.sort.${key}`).',

  'reader.vocab.tapAgainToStudy':
    'A mechanism difference, not copy: web\'s t() interpolates {{n}}, the shared t() does ' +
    'no interpolation at all and mobile hand-rolls .replace("{n}", …). Retire this by ' +
    'giving the shared t() a vars argument, not by editing the string.',
}

type Node = Record<string, unknown>
const flatten = (n: Node, p = '', o: Record<string, unknown> = {}) => {
  for (const [k, v] of Object.entries(n)) {
    const q = p ? `${p}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v as Node, q, o)
    else o[q] = v
  }
  return o
}

describe('web overrides of shared strings', () => {
  const w = flatten(web)
  const s = flatten(shared)
  const actual = Object.keys(w).filter(k => k in s && w[k] !== s[k]).sort()

  it('are exactly the ones written down here, with a reason each', () => {
    expect(actual).toEqual(Object.keys(OVERRIDES).sort())
  })

  it('are actually different — an override that matches shared is dead weight', () => {
    // Catches the other rot: someone edits shared to match, and the override
    // silently becomes a duplicate again.
    const same = Object.keys(OVERRIDES).filter(k => k in s && w[k] === s[k])
    expect(same).toEqual([])
  })

  it('every override still exists in shared — otherwise it is not an override', () => {
    const orphaned = Object.keys(OVERRIDES).filter(k => !(k in s))
    expect(orphaned).toEqual([])
  })
})
