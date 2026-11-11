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

const rel = (tag, at) => ({ tag_name: tag, created_at: at, html_url: `u/${tag}` })
const pr = (number, merged, labels = [], body = '') => ({
  number,
  title: `t${number}`,
  html_url: `p/${number}`,
  body,
  labels: labels.map((name) => ({ name })),
  pull_request: { merged_at: merged },
})

describe('build', () => {
  const releases = [
    rel('v0.1.0', '2026-05-06T00:00:00Z'),
    rel('2026.11.12', '2026-11-12T10:00:00Z'), // baseline
    rel('2026.11.13', '2026-11-13T10:00:00Z'),
    rel('2026.11.13.2', '2026-11-13T15:00:00Z'),
  ]
  const now = new Date('2026-11-14T09:00:00Z')

  it('puts each PR under the first release after its merge, unreleased under today, newest first', () => {
    const out = build(
      releases,
      [
        pr(1, '2026-11-12T09:00:00Z'), // before baseline: frozen CHANGELOG's
        pr(2, '2026-11-12T11:00:00Z', ['reader']),
        pr(3, '2026-11-13T12:00:00Z', ['ops']),
        pr(4, '2026-11-13T09:00:00Z', ['mobile']),
        pr(5, '2026-11-14T08:00:00Z', ['data']),
        pr(6, '2026-11-13T11:00:00Z', ['dependencies']),
      ],
      now,
    )
    expect(out.map((g) => [g.tag, g.date, g.prs.map((p) => p.number)])).toEqual([
      [null, '2026-11-14', [5]],
      ['2026.11.13.2', '2026-11-13', [3]],
      ['2026.11.13', '2026-11-13', [4, 2]],
    ])
  })

  it('attaches the reader block to public PRs; a bad block warns and drops only the block', () => {
    const warned = []
    const out = build(
      releases,
      [pr(7, '2026-11-14T08:00:00Z', ['reader', 'public'], block), pr(8, '2026-11-14T08:00:00Z', ['public'], 'none')],
      now,
      (m) => warned.push(m),
    )
    const [p8, p7] = out[0].prs
    expect(p7.public.kind).toBe('New')
    expect(p8.public).toBeUndefined()
    expect(warned).toEqual(['#8: no "## Public" section in the description'])
  })

  it('is empty before the first dated release', () => {
    expect(build([releases[0]], [pr(9, '2026-11-14T08:00:00Z')], now)).toEqual([])
  })
})
