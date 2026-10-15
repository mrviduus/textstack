import { describe, it, expect } from 'vitest'
import { matchesChapter } from './highlightChapter'

/**
 * The reflow WebView paints whatever it is handed — matchesChapter is the only chapter gate (the
 * engine page refuses a kind:"pdf" anchor itself: readerEnginePage.test.ts).
 * Behaviour pinned as it ships: the ROW's FK columns decide, the anchor never does.
 */
const row = (r: { chapterId?: string | null; userChapterId?: string | null; anchor?: object }) => ({
  chapterId: (r.chapterId ?? null) as string,
  userChapterId: r.userChapterId ?? null,
  anchorJson: JSON.stringify(r.anchor ?? { exact: 'hello' }),
})

describe('matchesChapter', () => {
  it('a catalog row matches on chapterId', () => {
    expect(matchesChapter(row({ chapterId: 'c1' }), 'c1')).toBe(true)
    expect(matchesChapter(row({ chapterId: 'c1' }), 'c2')).toBe(false)
  })

  it('an upload row matches on userChapterId', () => {
    expect(matchesChapter(row({ userChapterId: 'u1' }), 'u1')).toBe(true)
    expect(matchesChapter(row({ userChapterId: 'u1' }), 'u2')).toBe(false)
  })

  it('anchor.chapterId alone does not match — only the row columns count', () => {
    expect(matchesChapter(row({ anchor: { exact: 'hello', chapterId: 'c1' } }), 'c1')).toBe(false)
  })

  it('a mobile anchor with no chapterId matches by its row', () => {
    const r = row({ chapterId: 'c1', anchor: { exact: 'hello', prefix: 'say ', suffix: ' world' } })
    expect(matchesChapter(r, 'c1')).toBe(true)
    expect(matchesChapter(r, 'c2')).toBe(false)
  })

  it('a kind:"pdf" highlight (saved chapterless) never matches a reflow chapter', () => {
    const pdf = row({ anchor: { v: 1, kind: 'pdf', page: 3, rects: [], exact: 'hello' } })
    for (const id of ['c1', 'u1', '']) expect(matchesChapter(pdf, id)).toBe(false)
  })
})
