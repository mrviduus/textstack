import { describe, it, expect } from 'vitest'
import { build, parsePublic } from './changelog-data.mjs'

const block = '## Summary\n\nx\n\n## Public\nTitle: Read AZW3 books\nWeb, Android · New\nYour AZW3 files open.\nThey keep your place.\n\n## Tests\n- y'

describe('parsePublic', () => {
  it('reads title, where, kind and the sentences up to the next section', () => {
    expect(parsePublic(block)).toEqual({
      title: 'Read AZW3 books',
      where: ['Web', 'Android'],
      kind: 'New',
      text: 'Your AZW3 files open. They keep your place.',
    })
  })

  it('reads a block that ends the description', () => {
    expect(parsePublic('## Public\nTitle: T\nAndroid · Fix\nS.').where).toEqual(['Android'])
  })

  it('names what is wrong', () => {
    expect(() => parsePublic('no block')).toThrow(/no "## Public"/)
    expect(() => parsePublic('## Public\nT\nWeb · New\nS.')).toThrow(/Title:/)
    expect(() => parsePublic('## Public\nTitle: T\nWeb · Feature\nS.')).toThrow(/second line/)
    expect(() => parsePublic('## Public\nTitle: T\niOS · New\nS.')).toThrow(/second line/)
    expect(() => parsePublic('## Public\nTitle: T\nWeb · New\n\n## Next\nS.')).toThrow(/sentences/)
  })
})

const pr = (number, merged, labels = [], body = '') => ({
  number,
  title: `t${number}`,
  html_url: `p/${number}`,
  body,
  labels: labels.map((name) => ({ name })),
  pull_request: { merged_at: merged },
})

describe('build', () => {
  it('keeps PRs merged since the switch, drops Dependabot, newest first', () => {
    const out = build([
      pr(1, '2026-11-11T09:00:00Z'), // before the switch: frozen CHANGELOG's
      pr(2, '2026-11-12T11:00:00Z', ['reader']),
      pr(3, '2026-11-13T12:00:00Z', ['ops']),
      pr(4, '2026-11-13T11:00:00Z', ['dependencies']),
    ])
    expect(out.map((p) => [p.number, p.mergedAt])).toEqual([
      [3, '2026-11-13T12:00:00Z'],
      [2, '2026-11-12T11:00:00Z'],
    ])
  })

  it('attaches the reader block to public PRs; a bad block warns and drops only the block', () => {
    const warned = []
    const out = build(
      [pr(7, '2026-11-14T08:00:00Z', ['reader', 'public'], block), pr(8, '2026-11-14T07:00:00Z', ['public'], 'none')],
      (m) => warned.push(m),
    )
    expect(out[0].public.kind).toBe('New')
    expect(out[1].public).toBeUndefined()
    expect(warned).toEqual(['#8: no "## Public" section in the description'])
  })
})
