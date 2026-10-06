import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTextAnchor, findTextByAnchor, highlightChapterKey } from './textAnchor'
import type { HighlightAnchor } from './offlineDb'
import {
  ANCHOR_CASES,
  ANCHOR_CHAPTERS,
  CHAPTER_A_ID,
  CHAPTER_B_ID,
  PRODUCER_ONLY_CASES,
  caseStart,
  type AnchorFixtureFile,
} from '../../../../packages/shared/src/reader/__fixtures__/anchors/chapters'

/**
 * Cross-app anchors, web side. In R2 (#719) highlights made on the phone
 * vanished on the web: mobile anchors carry no chapterId and the web keyed on
 * it. These tests resolve every producer's frozen anchor — web, mobile (made by
 * the WebView's real creator in apps/mobile/src/lib/crossAppAnchors.test.ts) and
 * MCP — through the path the reader paints with: highlightChapterKey(row) →
 * findTextByAnchor, over a container with several chapters mounted.
 *
 * Fixtures: packages/shared/src/reader/__fixtures__/anchors/. Regenerate
 * web.json with UPDATE_ANCHOR_FIXTURES=1.
 */

const FIXTURES = join(__dirname, '../../../../packages/shared/src/reader/__fixtures__/anchors')
const UPDATE = process.env.UPDATE_ANCHOR_FIXTURES === '1'
const read = (f: string): AnchorFixtureFile => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'))

let container: HTMLElement

/** The scroll container with chapter articles, as ReaderSection renders them. */
function mount(chapterIds: string[]) {
  container.innerHTML = ''
  for (const ch of ANCHOR_CHAPTERS.filter((c) => chapterIds.includes(c.id))) {
    const article = document.createElement('article')
    article.dataset.chapterId = ch.id
    article.dataset.chapterSlug = ch.slug
    article.innerHTML = ch.html
    container.appendChild(article)
  }
}

const article = (id: string) => container.querySelector<HTMLElement>(`[data-chapter-id="${id}"]`)!

function rangeAt(scope: Node, start: number, length: number): Range {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let pos = 0
  let startSet = false
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length
    if (!startSet && pos + len > start) { range.setStart(n, start - pos); startSet = true }
    if (startSet && pos + len >= start + length) { range.setEnd(n, start + length - pos); return range }
    pos += len
  }
  throw new Error('range out of bounds')
}

/** Offset of a range's start within its chapter article's text. */
function offsetIn(scope: HTMLElement, r: Range): number {
  const pre = document.createRange()
  pre.setStart(scope, 0)
  pre.setEnd(r.startContainer, r.startOffset)
  return pre.toString().length
}

const chapterOf = (r: Range) =>
  (r.startContainer.parentElement!.closest('[data-chapter-id]') as HTMLElement).dataset.chapterId

/** A highlight row as each client stores it: edition rows carry chapterId, upload rows userChapterId. */
type Row = { anchor: HighlightAnchor; chapterId?: string | null; userChapterId?: string | null }
const rowsFor = (anchor: HighlightAnchor, chapterId: string): Record<string, Row> => ({
  edition: { anchor, chapterId },
  upload: { anchor, chapterId: '', userChapterId: chapterId },
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.innerHTML = ''
  document.body.appendChild(container)
  mount(ANCHOR_CHAPTERS.map((c) => c.id))
})

const generated: AnchorFixtureFile = {}

describe('web anchor creator (createTextAnchor)', () => {
  for (const c of ANCHOR_CASES) {
    it(`${c.name}: anchor matches the frozen web fixture`, () => {
      const scope = article(c.chapter)
      const anchor = createTextAnchor(rangeAt(scope, caseStart(scope.textContent!, c), c.exact.length), 'active-chapter', container)
      expect(anchor.exact).toBe(c.exact)
      // The wrapper the selection sits in wins over the caller's "active" chapter.
      expect(anchor.chapterId).toBe(c.chapter)
      generated[c.name] = anchor as unknown as AnchorFixtureFile[string]
      if (!UPDATE) expect(anchor).toEqual(read('web.json')[c.name])
    })
  }

  afterAll(() => {
    if (UPDATE) writeFileSync(join(FIXTURES, 'web.json'), JSON.stringify(generated, null, 2) + '\n')
  })
})

describe('web resolver resolves every producer in the right chapter', () => {
  for (const file of ['web.json', 'mobile.json', 'mcp.json']) {
    describe(file, () => {
      for (const [name, raw] of Object.entries(read(file))) {
        const c = ANCHOR_CASES.find((x) => x.name === name)
        const chapterId = c?.chapter ?? (raw.chapterId as string)
        const want = c?.exact ?? PRODUCER_ONLY_CASES[name]
        for (const [shape, row] of Object.entries(rowsFor(raw as unknown as HighlightAnchor, chapterId))) {
          it(`${name} (${shape} row)`, () => {
            const key = highlightChapterKey(row)
            expect(key).toBe(chapterId)
            const range = findTextByAnchor(row.anchor, container, key)
            expect(range).not.toBeNull()
            expect(range!.toString()).toBe(want)
            expect(chapterOf(range!)).toBe(chapterId)
          })
        }
      }
    })
  }

  it('mobile anchors carry no chapterId: the row is the only key, and without one nothing paints', () => {
    const anchor = read('mobile.json')['inline-tags'] as unknown as HighlightAnchor
    expect((anchor as { chapterId?: string }).chapterId).toBeUndefined()
    const key = highlightChapterKey({ anchor, chapterId: '', userChapterId: null })
    expect(key).toBeNull()
    expect(findTextByAnchor(anchor, container, key)).toBeNull()
    // The default key comes from the anchor alone — so a caller that forgets the row loses mobile highlights.
    expect(findTextByAnchor(anchor, container)).toBeNull()
  })
})

describe('repeated phrase', () => {
  const scopeText = () => article(CHAPTER_A_ID).textContent!
  const first = () => scopeText().indexOf('said the word again')
  const second = () => scopeText().indexOf('said the word again', first() + 1)

  for (const file of ['web.json', 'mobile.json']) {
    it(`${file}: prefix/suffix pick the selected occurrence`, () => {
      const fx = read(file)
      const r1 = findTextByAnchor(fx['repeated-first'] as unknown as HighlightAnchor, container, CHAPTER_A_ID)!
      const r2 = findTextByAnchor(fx['repeated-second'] as unknown as HighlightAnchor, container, CHAPTER_A_ID)!
      expect(offsetIn(article(CHAPTER_A_ID), r1)).toBe(first())
      expect(offsetIn(article(CHAPTER_A_ID), r2)).toBe(second())
    })
  }

  it('mcp.json: no context, so a repeated quote lands on the first occurrence (known limit)', () => {
    const r = findTextByAnchor(read('mcp.json')['repeated-first'] as unknown as HighlightAnchor, container, CHAPTER_A_ID)!
    expect(offsetIn(article(CHAPTER_A_ID), r)).toBe(first())
  })
})

describe('an anchor from chapter A never paints in chapter B', () => {
  // Chapter B repeats A's phrases ("said the word again", the hallway line), so
  // only the chapter scope keeps these out of it.
  const fromA = (file: string) =>
    Object.entries(read(file)).filter(([name, a]) =>
      (ANCHOR_CASES.find((x) => x.name === name)?.chapter ?? a.chapterId) === CHAPTER_A_ID)

  for (const file of ['web.json', 'mobile.json', 'mcp.json']) {
    it(`${file}: with A unmounted, nothing resolves`, () => {
      mount([CHAPTER_B_ID])
      const shared = fromA(file).filter(([, a]) => article(CHAPTER_B_ID).textContent!.includes(a.exact))
      expect(shared.length).toBeGreaterThan(0) // the fixture really does share text with B
      for (const [name, a] of fromA(file)) {
        const range = findTextByAnchor(a as unknown as HighlightAnchor, container, highlightChapterKey({ anchor: a as unknown as HighlightAnchor, chapterId: CHAPTER_A_ID }))
        expect(range, name).toBeNull()
      }
    })

    it(`${file}: with A and B both mounted, every range lands in A`, () => {
      // B first in document order, so a scope-blind search would hit B's copy.
      mount([CHAPTER_B_ID, CHAPTER_A_ID])
      container.insertBefore(article(CHAPTER_B_ID), article(CHAPTER_A_ID))
      for (const [name, a] of fromA(file)) {
        const range = findTextByAnchor(a as unknown as HighlightAnchor, container, CHAPTER_A_ID)
        expect(range, name).not.toBeNull()
        expect(chapterOf(range!), name).toBe(CHAPTER_A_ID)
      }
    })
  }
})

describe('KNOWN BUG: a mobile selection across paragraphs, as a real WebView serializes it', () => {
  // getSelectionAnchor (apps/mobile/src/lib/readerBridge.ts) takes `exact` from
  // Selection.toString(), which Chromium/WebKit serialize like innerText —
  // block breaks become "\n\n" — while prefix/suffix come from Range.toString()
  // (raw text nodes). jsdom serializes both raw, so mobile.json cannot show it;
  // this is the anchor a phone would actually send. `it.fails`: flips red once
  // the creator takes `exact` from the Range — then make it a plain `it`.
  const fromDevice = (exact: string) => ({
    ...read('mobile.json')['across-paragraphs'],
    exact,
  }) as unknown as HighlightAnchor

  it.fails('resolves to the selected passage', () => {
    const range = findTextByAnchor(fromDevice('striking thirteen.\n\nThe hallway'), container, CHAPTER_A_ID)
    // Today: the fuzzy fallback lands 2 characters early ("e striking thirteen.The hallway").
    expect(range?.toString()).toBe('striking thirteen.The hallway')
  })

  it.fails('a short cross-paragraph selection still resolves', () => {
    // Today: null — the highlight is saved but never painted, on either client.
    expect(findTextByAnchor(fromDevice('thirteen.\n\nThe'), container, CHAPTER_A_ID)).not.toBeNull()
  })
})

describe('PDF anchors never resolve as text', () => {
  const pdf = { v: 1, kind: 'pdf', page: 3, rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }], exact: 'said the word again' } as unknown as HighlightAnchor

  it('findTextByAnchor refuses a kind:"pdf" anchor even when its text is on screen', () => {
    expect(findTextByAnchor(pdf, container, CHAPTER_A_ID)).toBeNull()
  })

  it('highlightChapterKey ignores a pdf anchor and falls back to the row', () => {
    expect(highlightChapterKey({ anchor: pdf, chapterId: null })).toBeNull()
  })
})
