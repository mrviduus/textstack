import { describe, it, expect } from 'vitest'
import { areaOf, byWeek, readerEntries, weekOf, type ChangelogData, type ReaderEntry } from './changelog'

const pub = { title: 'T', where: ['Web' as const], kind: 'New' as const, text: 'S.' }

describe('changelog feed', () => {
  it('weekOf is the Monday, Sunday included', () => {
    expect(weekOf('2026-11-11')).toBe('2026-11-09')
    expect(weekOf('2026-11-15T23:00:00Z')).toBe('2026-11-09')
    expect(weekOf('2026-11-16')).toBe('2026-11-16')
  })

  it('reader entries: public PRs only, merged with the seed, grouped by week newest first', () => {
    const data: ChangelogData = {
      prs: [
        { number: 5, title: 'x', url: 'p5', labels: ['ops', 'reading', 'public'], mergedAt: '2026-11-17T10:00:00Z', public: pub },
        { number: 2, title: 'y', url: 'p2', labels: ['reading'], mergedAt: '2026-11-12T10:00:00Z' },
      ],
    }
    const seed: ReaderEntry[] = [
      { ...pub, title: 'old', date: '2026-11-10', area: 'library' },
      { ...pub, title: 'same week', date: '2026-11-18', area: 'highlights' },
    ]
    const weeks = byWeek(readerEntries(data, seed), (e) => e.date)
    expect(weeks.map(([w, es]) => [w, es.map((e) => e.title)])).toEqual([
      ['2026-11-16', ['same week', 'T']],
      ['2026-11-09', ['old']],
    ])
    expect(weeks[0][1][1]).toMatchObject({ area: 'reading', url: 'p5' })
  })

  it('areaOf follows release-notes order and ignores non-area labels', () => {
    expect(areaOf(['ops', 'reading'])).toBe('reading')
    expect(areaOf(['public', 'bug'])).toBeNull()
  })
})
