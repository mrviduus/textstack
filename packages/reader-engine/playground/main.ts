// The engine on a real chapter in a real browser: geometry jsdom cannot do (Playwright, geometry.e2e.ts),
// and a page to look at (`pnpm -C packages/reader-engine playground`). `?chapter=<file in chapters/>`.
import type { Locator } from '../src/api'
import { createEngine } from '../src/engine'
import { resolveLocator } from '../src/resolve'
import { chapterText, locatorAt, rangeAt } from '../src/text'
// The old web reader's caret probe, the yardstick for the engine's reading line (#789).
import { articleText, readReadingLine } from './readingLine'

const href = new URLSearchParams(location.search).get('chapter') ?? 'moby-dick-5'
const root = document.getElementById('reader')!
const engine = createEngine(root)
const content = root.firstElementChild as HTMLElement   // the chapter; the decoration layer is beside it

const html = await (await fetch(`./chapters/${href}.html`)).text()
await engine.open({ href, layout: 'reflow', html })

const pg = {
  /** The web probe and the engine read the same text, or their offsets cannot be compared. */
  sameText: () => articleText(content) === chapterText(content),
  /** Chapter offset under the reading line, by the web reader's probe. */
  probe: () => readReadingLine(content, innerHeight * 0.25)?.charOffset ?? null,
  /** Chapter offset a locator lands on (exact or fuzzy quote), else null. */
  offsetOf(loc: Locator) {
    const r = resolveLocator(loc, href, chapterText(content))
    return r && (r.result === 'exact' || r.result === 'fuzzy') ? r.offset : null
  },
  /** Page y of the middle of the first visible character from a chapter offset (whitespace and soft hyphens have no box). */
  yOf(offset: number) {
    const text = chapterText(content)
    while (/[\s\u00AD]/.test(text[offset])) offset++
    const r = rangeAt(content, offset, 1)!.getBoundingClientRect()
    return r.top + r.height / 2 + scrollY
  },
  /** How far page y is from the line box of the first visible character from an offset: 0 on it. */
  offLine(offset: number, y: number) {
    const text = chapterText(content)
    while (/[\s\u00AD\u200B\u2060\uFEFF]/.test(text[offset])) offset++
    const r = rangeAt(content, offset, 1)!.getBoundingClientRect()
    return Math.max(0, r.top + scrollY - y, y - (r.bottom + scrollY))
  },
  lineHeight: () => parseFloat(getComputedStyle(content).lineHeight),
  text: () => chapterText(content),
  /** A stored reading position at a chapter offset, as the apps build one. */
  placeAt: (offset: number) => locatorAt(chapterText(content), offset, href, 0.5)!,
}

Object.assign(window, { engine, pg })
document.body.dataset.ready = 'true'
