import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { buildReaderHtml } from './readerHtml'
import {
  ANCHOR_CASES,
  ANCHOR_CHAPTERS,
  CHAPTER_A_ID,
  CHAPTER_B_ID,
  caseStart,
  chapterById,
  PRODUCER_ONLY_CASES,
  type AnchorFixtureChapter,
  type AnchorFixtureFile,
} from '../../../../packages/shared/src/reader/__fixtures__/anchors/chapters'

/**
 * Cross-app anchors, mobile side — on the document the WebView actually loads.
 *
 * `buildReaderHtml` is rendered into jsdom with its scripts running, so the
 * anchor CREATOR is the bridge's real `getSelectionAnchor` (prefix/suffix from
 * Ranges over document.body) and the RESOLVER is the real `hlBuildRange` over
 * the inlined shared resolver bundle — not a copy of either.
 *
 * Fixtures: packages/shared/src/reader/__fixtures__/anchors/. Regenerate
 * mobile.json with UPDATE_ANCHOR_FIXTURES=1.
 *
 * Not covered here: which chapter a highlight is painted in. The WebView holds
 * one chapter and paints whatever RN hands it; the gate is `matchesChapter` in
 * hooks/useReaderHighlights.ts (row columns only), outside this suite's scope.
 */

// jsdom ships no types and mobile has no @types/jsdom; only these two are used.
const { JSDOM, VirtualConsole } = createRequire(__filename)('jsdom') as {
  JSDOM: new (html: string, opts: Record<string, unknown>) => { window: unknown }
  VirtualConsole: new () => unknown
}

const FIXTURES = join(__dirname, '../../../../packages/shared/src/reader/__fixtures__/anchors')
const UPDATE = process.env.UPDATE_ANCHOR_FIXTURES === '1'
const read = (f: string): AnchorFixtureFile => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'))

type ReaderWindow = Window & {
  getSelectionAnchor: () => { prefix: string; exact: string; suffix: string } | null
  hlBuildRange: (anchor: unknown) => Range | null
  __TSAnchor?: unknown
}

const docs = new Map<string, ReaderWindow>()
function reader(ch: AnchorFixtureChapter): ReaderWindow {
  let w = docs.get(ch.id)
  if (w) return w
  const dom = new JSDOM(buildReaderHtml(ch.html, undefined, ch.slug), {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    // Overlay/vocab code paths poke at layout APIs jsdom lacks; they are not under test.
    virtualConsole: new VirtualConsole(),
    beforeParse(win: unknown) {
      ;(win as { ReactNativeWebView: unknown }).ReactNativeWebView = { postMessage: () => {} }
    },
  })
  w = dom.window as unknown as ReaderWindow
  docs.set(ch.id, w)
  return w
}

/** The chapter element's text — what the reader sees, and what a selection is cut from. */
function chapterEl(w: ReaderWindow): HTMLElement {
  return w.document.querySelector('[data-chapter-slug]') as HTMLElement
}

function rangeAt(w: ReaderWindow, scope: Node, start: number, length: number): Range {
  const walker = w.document.createTreeWalker(scope, 4 /* SHOW_TEXT */)
  const range = w.document.createRange()
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

function select(w: ReaderWindow, range: Range) {
  const sel = w.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

const generated: AnchorFixtureFile = {}

describe('mobile anchor creator (getSelectionAnchor in the real reader document)', () => {
  it('the reader document exposes the creator, the resolver and the shared resolver bundle', () => {
    const w = reader(ANCHOR_CHAPTERS[0])
    expect(typeof w.getSelectionAnchor).toBe('function')
    expect(typeof w.hlBuildRange).toBe('function')
    // Without the bundle hlFindAnchor silently degrades to a bare indexOf.
    expect(w.__TSAnchor).toBeTruthy()
  })

  for (const c of ANCHOR_CASES) {
    it(`${c.name}: anchor matches the frozen mobile fixture`, () => {
      const w = reader(chapterById(c.chapter))
      const el = chapterEl(w)
      select(w, rangeAt(w, el, caseStart(el.textContent!, c), c.exact.length))
      const anchor = w.getSelectionAnchor()!
      expect(anchor.exact).toBe(c.exact)
      // The shape mobile posts: no chapterId and no offsets — the row's columns carry the chapter.
      expect(Object.keys(anchor).sort()).toEqual(['exact', 'prefix', 'suffix'])
      generated[c.name] = anchor
      if (!UPDATE) expect(anchor).toEqual(read('mobile.json')[c.name])
    })
  }

  afterAll(() => {
    if (UPDATE) writeFileSync(join(FIXTURES, 'mobile.json'), JSON.stringify(generated, null, 2) + '\n')
  })
})

describe('mobile resolver (hlBuildRange) resolves every producer', () => {
  const producers = ['web.json', 'mobile.json', 'mcp.json'] as const

  for (const file of producers) {
    describe(file, () => {
      for (const [name, anchor] of Object.entries(read(file))) {
        const c = ANCHOR_CASES.find((x) => x.name === name)
        it(`${name}: resolves to the selected text`, () => {
          const chapterId = c?.chapter ?? (anchor.chapterId as string)
          const w = reader(chapterById(chapterId))
          const range = w.hlBuildRange(anchor)
          expect(range).not.toBeNull()
          // The original passage, whatever spacing the producer quoted (nbsp-as-space).
          const want = c?.exact ?? PRODUCER_ONLY_CASES[name]
          expect(range!.toString()).toBe(want)
        })
      }
    })
  }

  it('repeated phrase: context picks the right occurrence (web + mobile)', () => {
    const w = reader(chapterById(CHAPTER_A_ID))
    const text = w.document.body.textContent!
    const first = text.indexOf('said the word again')
    const second = text.indexOf('said the word again', first + 1)
    for (const file of ['web.json', 'mobile.json']) {
      const fx = read(file)
      const r1 = w.hlBuildRange(fx['repeated-first'])!
      const r2 = w.hlBuildRange(fx['repeated-second'])!
      // Offset of each range's start within the body's text.
      const offsetOf = (r: Range) => {
        const pre = w.document.createRange()
        pre.setStart(w.document.body, 0)
        pre.setEnd(r.startContainer, r.startOffset)
        return pre.toString().length
      }
      expect(offsetOf(r1), file).toBe(first)
      expect(offsetOf(r2), file).toBe(second)
    }
  })

  it('an anchor from chapter A resolves nowhere in chapter B unless its text is there', () => {
    // The WebView has no chapter gate of its own (see header). This pins the
    // consequence: text unique to A never paints in B, and shared text WOULD,
    // so RN's matchesChapter is the only thing standing between them.
    const w = reader(chapterById(CHAPTER_B_ID))
    const web = read('web.json')
    expect(w.hlBuildRange(web['inline-tags'])).toBeNull()
    expect(w.hlBuildRange(web['repeated-second'])).not.toBeNull()
  })
})
