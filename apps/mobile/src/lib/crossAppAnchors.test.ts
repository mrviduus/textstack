import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openEnginePage, type EnginePage } from '../test/enginePage'
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
  /** The text renderHighlight drew for `anchor`, and where it starts in the chapter; null = nothing drawn. */
  resolve(anchor: unknown): { text: string; offset: number } | null
}

const docs = new Map<string, Promise<Reader>>()
function reader(ch: AnchorFixtureChapter): Promise<Reader> {
  let r = docs.get(ch.id)
  if (!r) { r = boot(ch); docs.set(ch.id, r) }
  return r
}

const settled = () => new Promise((res) => setTimeout(res, 260))

async function boot(ch: AnchorFixtureChapter): Promise<Reader> {
  const page = await openEnginePage(ch.html, ch.slug)
  // The engine measures each mark's whole Range once to draw it: record what it measured.
  const measured: Range[] = []
  const rects = page.w.Range.prototype.getClientRects
  page.w.Range.prototype.getClientRects = function (this: Range) { measured.push(this.cloneRange()); return rects.call(this) }
  const lastSelection = () => page.messages.filter((x) => x.type === 'selection').at(-1)
  const anchorFor = async (range: Range) => {
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
  }
  const resolve = (anchor: unknown) => {
    measured.length = 0
    page.call(`renderHighlight('x', ${JSON.stringify(JSON.stringify(anchor))}, 'yellow', '')`)
    const drawn = measured.at(-1)
    page.call(`removeHighlight('x')`)
    return drawn ? { text: drawn.toString(), offset: offsetOf(page.root, drawn) } : null
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

  it('takes exact from the Range, not from a WebView-serialized Selection', async () => {
    // Chromium/WebKit serialize a Selection like innerText — a paragraph break
    // becomes newlines. jsdom does not, so fake the device's serialization.
    const r = await reader(chapterById(CHAPTER_A_ID))
    const c = ANCHOR_CASES.find((x) => x.name === 'across-paragraphs')!
    const el = chapterEl(r)
    const range = rangeAt(r, el, caseStart(el.textContent!, c), c.exact.length)
    const sel = r.w.document.getSelection()!
    const real = sel.toString
    sel.toString = () => 'striking thirteen.\n\nThe hallway'
    try {
      expect((await r.anchorFor(range))!.exact).toBe(c.exact)
    } finally {
      sel.toString = real
    }
  })

  afterAll(() => {
    if (UPDATE) writeFileSync(join(FIXTURES, 'mobile.json'), JSON.stringify(generated, null, 2) + '\n')
  })
})

describe("mobile resolver (the engine page's renderHighlight) resolves every producer", () => {
  const producers = ['web.json', 'mobile.json', 'mcp.json'] as const

  for (const file of producers) {
    describe(file, () => {
      for (const [name, anchor] of Object.entries(read(file))) {
        const c = ANCHOR_CASES.find((x) => x.name === name)
        it(`${name}: resolves to the selected text`, async () => {
          const chapterId = c?.chapter ?? (anchor.chapterId as string)
          const r = await reader(chapterById(chapterId))
          // The original passage, whatever spacing the producer quoted (nbsp-as-space).
          const want = c?.exact ?? PRODUCER_ONLY_CASES[name]
          expect(r.resolve(anchor)?.text).toBe(want)
        })
      }
    })
  }

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
