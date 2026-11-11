import { describe, it, expect } from 'vitest'
import { areaOf, readerFeed, type ChangelogData, type ReaderEntry } from './changelog'

const pub = { title: 'T', where: ['Web' as const], kind: 'New' as const, text: 'S.' }

describe('readerFeed', () => {
  it('keeps public PRs only, dated by their release, merged with the seed newest first', () => {
    const data: ChangelogData = {
      releases: [
        { tag: null, date: '2026-11-14', url: null, prs: [{ number: 5, title: 'x', url: 'p5', labels: ['ops', 'reader', 'public'], public: pub }] },
        { tag: '2026.11.12', date: '2026-11-12', url: 'r', prs: [{ number: 2, title: 'y', url: 'p2', labels: ['reader'] }] },
      ],
    }
    const seed: ReaderEntry[] = [
      { ...pub, title: 'old', date: '2026-10-01', area: 'library' },
      { ...pub, title: 'same day', date: '2026-11-14', area: 'mobile' },
    ]
    const feed = readerFeed(data, seed)
    expect(feed.map(([d, es]) => [d, es.map((e) => e.title)])).toEqual([
      ['2026-11-14', ['T', 'same day']],
      ['2026-10-01', ['old']],
    ])
    expect(feed[0][1][0]).toMatchObject({ area: 'reader', url: 'p5' })
  })

  it('areaOf follows release-notes order and ignores non-area labels', () => {
    expect(areaOf(['ops', 'reader'])).toBe('reader')
    expect(areaOf(['public', 'bug'])).toBeNull()
  })
})
