// The engine on a real chapter in a real browser: geometry jsdom cannot do (Playwright, geometry.e2e.ts),
// and a page to look at (`pnpm -C packages/reader-engine playground`). `?chapter=<file in chapters/>`.
import type { Locator } from '../src/api'
import { createEngine } from '../src/engine'
import { resolveLocator } from '../src/resolve'
import { chapterText, rangeAt } from '../src/text'
// The web reader's own caret probe, the yardstick for the engine's reading line (#789).
import { articleText, readReadingLine } from '../../../apps/web/src/lib/textAnchor'

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
  /** Page y of the middle of the first visible character from a chapter offset (whitespace has no box). */
  yOf(offset: number) {
    const text = chapterText(content)
    while (/\s/.test(text[offset])) offset++
    const r = rangeAt(content, offset, 1)!.getBoundingClientRect()
    return r.top + r.height / 2 + scrollY
  },
  lineHeight: () => parseFloat(getComputedStyle(content).lineHeight),
}

Object.assign(window, { engine, pg })
document.body.dataset.ready = 'true'
