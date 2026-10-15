import { describe, it, expect, afterAll, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openEnginePage, SETTLED_MS, type EnginePage } from '../test/enginePage'
import {
  ANCHOR_CASES,
  CHAPTER_A_ID,
  CHAPTER_B_ID,
  CHAPTER_EDGE_ID,
  caseStart,
  chapterById,
  PRODUCER_ONLY_CASES,
  type AnchorFixtureChapter,
  type AnchorFixtureFile,
} from '../../../../packages/shared/src/reader/__fixtures__/anchors/chapters'

/**
 * Cross-app anchors, mobile side — on the document the WebView actually loads.
 *
 * The engine page (`buildEngineReaderHtml`) is booted in jsdom with its scripts running, so the
 * anchor CREATOR is the page's real `selection` message (prefix/suffix cut by the engine from the
 * chapter text) and the RESOLVER is the page's real `renderHighlight` (the engine's resolveLocator)
 * — not a copy of either. What a highlight resolved to is read off the Range the engine measures
 * to draw it.
 *
 * Fixtures: packages/shared/src/reader/__fixtures__/anchors/. Regenerate
 * mobile.json with UPDATE_ANCHOR_FIXTURES=1.
 *
 * Not covered here: which chapter a highlight is painted in. The WebView holds
 * one chapter and paints whatever RN hands it; the gate is `matchesChapter` in
 * hooks/useReaderHighlights.ts (row columns only), outside this suite's scope.
 */

const FIXTURES = join(__dirname, '../../../../packages/shared/src/reader/__fixtures__/anchors')
const UPDATE = process.env.UPDATE_ANCHOR_FIXTURES === '1'
const read = (f: string): AnchorFixtureFile => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'))

type Anchor = { prefix: string; exact: string; suffix: string }
type Reader = EnginePage & {
  /** The anchor the page posts for the selection `range`, once it settles. */
  anchorFor(range: Range): Promise<Anchor | null>
  /** The text renderHighlight drew for `anchor` (its own mark, by id), and where it starts; null = nothing drawn. */
  resolve(anchor: unknown): { text: string; offset: number } | null
}

const docs = new Map<string, Promise<Reader>>()
function reader(ch: AnchorFixtureChapter): Promise<Reader> {
  let r = docs.get(ch.id)
  if (!r) { r = boot(ch); docs.set(ch.id, r) }
  return r
}

// The selection settle window, on fake time: the page's timers are jsdom's, which call the global setTimeout.
const settled = () => vi.advanceTimersByTimeAsync(SETTLED_MS)

async function boot(ch: AnchorFixtureChapter): Promise<Reader> {
  const page = await openEnginePage(ch.html, ch.slug)
  // No layout in jsdom: a range's one box encodes where it is in the chapter text (x = offset, width =
  // length), so a drawn mark's own <rect> says which text it covers.
  page.w.Range.prototype.getClientRects = function (this: Range) {
    const at = offsetOf(page.root, this), length = this.toString().length
    return [{ left: at, top: 0, right: at + length, bottom: 1, width: length, height: 1 }] as unknown as DOMRectList
  }
  const text = page.root.textContent!
  let ids = 0
  const lastSelection = () => page.messages.filter((x) => x.type === 'selection').at(-1)
  const anchorFor = async (range: Range) => {
    vi.useFakeTimers()
    try {
      const sel = page.w.document.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      page.w.document.dispatchEvent(new page.w.Event('selectionchange'))
      await settled()
      const anchor = (lastSelection()?.anchor as Anchor | undefined) ?? null
      sel.removeAllRanges()
      page.w.document.dispatchEvent(new page.w.Event('selectionchange'))
      await settled()
      return anchor
    } finally {
      vi.useRealTimers()   // the next chapter's page opens on real time
    }
  }
  const resolve = (anchor: unknown) => {
    const id = `hl-${++ids}`
    page.call(`renderHighlight('${id}', ${JSON.stringify(JSON.stringify(anchor))}, 'yellow', '')`)
    const box = page.root.querySelector(`svg [data-group="highlight"][data-id="${id}"] rect`)
    page.call(`removeHighlight('${id}')`)
    if (!box) return null
    const offset = Number(box.getAttribute('x')), length = Number(box.getAttribute('width'))
    return { text: text.slice(offset, offset + length), offset }
  }
  return { ...page, anchorFor, resolve }
}

/** The chapter element — what the reader sees, and what a selection is cut from. */
function chapterEl(r: Reader): HTMLElement {
  return r.root.firstElementChild as HTMLElement
}

/** Offset of a range's start within `scope`'s text. */
function offsetOf(scope: Node, r: Range) {
  const pre = scope.ownerDocument!.createRange()
  pre.setStart(scope, 0)
  pre.setEnd(r.startContainer, r.startOffset)
  return pre.toString().length
}

function rangeAt(r: Reader, scope: Node, start: number, length: number): Range {
  const walker = r.w.document.createTreeWalker(scope, 4 /* SHOW_TEXT */)
  const range = r.w.document.createRange()
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

const generated: AnchorFixtureFile = {}

describe("mobile anchor creator (the engine page's selection message)", () => {
  for (const c of ANCHOR_CASES) {
    it(`${c.name}: anchor matches the frozen mobile fixture`, async () => {
      const r = await reader(chapterById(c.chapter))
      const el = chapterEl(r)
      const anchor = (await r.anchorFor(rangeAt(r, el, caseStart(el.textContent!, c), c.exact.length)))!
      expect(anchor.exact).toBe(c.exact)
      // The shape mobile posts: no chapterId and no offsets — the row's columns carry the chapter.
      expect(Object.keys(anchor).sort()).toEqual(['exact', 'prefix', 'suffix'])
      generated[c.name] = anchor
      if (!UPDATE) expect(anchor).toEqual(read('mobile.json')[c.name])
    })
  }

  it('quotes the same context as the web for every selection', () => {
    // Both cut prefix/suffix from the chapter text, so the only difference
    // left is the fields mobile does not send (offsets, chapterId).
    const web = read('web.json')
    for (const c of ANCHOR_CASES) {
      const { prefix, exact, suffix } = web[c.name]
      expect(generated[c.name], c.name).toEqual({ prefix, exact, suffix })
    }
  })

  // A Selection serialized like innerText (newlines at paragraph breaks) never reaches the anchor: the
  // engine cuts `exact` from its chapter text by offsets (E20); `across-paragraphs` above pins the result.

  afterAll(() => {
    if (UPDATE) writeFileSync(join(FIXTURES, 'mobile.json'), JSON.stringify(generated, null, 2) + '\n')
  })
})

describe("mobile resolver (the engine page's renderHighlight)", () => {
  // Every row of every producer is resolved by the engine itself (reader-engine text.test.ts T3, same
  // fixture files). Here: that the page's renderHighlight bridge hands an anchor to it and paints it.
  it.each([
    ['web.json', 'inline-tags'],
    ['mobile.json', 'inline-tags'],
    ['mcp.json', 'inline-tags'],
    ['mcp.json', 'nbsp-as-space'],   // a producer-only row: quoted with a plain space
  ])('%s %s: resolves to the selected text', async (file, name) => {
    const anchor = read(file)[name]
    const c = ANCHOR_CASES.find((x) => x.name === name)
    const r = await reader(chapterById(c?.chapter ?? (anchor.chapterId as string)))
    expect(r.resolve(anchor)?.text).toBe(c?.exact ?? PRODUCER_ONLY_CASES[name])
  })

  const repeats: [string, string, string][] = [
    [CHAPTER_A_ID, 'repeated-first', 'repeated-second'],
    // At the chapter's edges one side of the context is empty.
    [CHAPTER_EDGE_ID, 'edge-repeat-start', 'edge-repeat-end'],
  ]
  for (const [chapterId, firstCase, secondCase] of repeats) {
    it(`repeated phrase (${firstCase}/${secondCase}): context picks the right occurrence (web + mobile)`, async () => {
      const r = await reader(chapterById(chapterId))
      const text = r.root.textContent!
      const first = text.indexOf('said the word again')
      const second = text.indexOf('said the word again', first + 1)
      for (const file of ['web.json', 'mobile.json']) {
        const fx = read(file)
        expect(r.resolve(fx[firstCase])?.offset, file).toBe(first)
        expect(r.resolve(fx[secondCase])?.offset, file).toBe(second)
      }
    })
  }

  it('an anchor from chapter A resolves nowhere in chapter B unless its text is there', async () => {
    // The WebView has no chapter gate of its own (see header). This pins the
    // consequence: text unique to A never paints in B, and shared text WOULD,
    // so RN's matchesChapter is the only thing standing between them.
    const r = await reader(chapterById(CHAPTER_B_ID))
    const web = read('web.json')
    expect(r.resolve(web['inline-tags'])).toBeNull()
    expect(r.resolve(web['repeated-second'])).not.toBeNull()
  })
})
