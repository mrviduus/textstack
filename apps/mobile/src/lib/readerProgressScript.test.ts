import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tests the progress reporter that actually ships.
 *
 * `reportProgress` lives inside the HTML string handed to the reader WebView,
 * so it cannot be imported. Rather than leave the most consequential arithmetic
 * in the app untested, this extracts the two functions from the source and runs
 * them against a fake DOM.
 *
 * What it locks down: React Native feeds this value to `computeBookProgress()`
 * as the WITHIN-CHAPTER fraction, so it must be measured against the chapter
 * element — not the document, which also holds the end-of-chapter block (and,
 * until 2026-10-03, appended chapters: the book percent ran backwards every
 * time one landed). The scroll offset is chapter-relative for the same reason.
 */

const SOURCE = readFileSync(join(__dirname, 'readerHtml.ts'), 'utf8')

function extractFunction(name: string): string {
  const start = SOURCE.indexOf(`function ${name}()`)
  if (start < 0) throw new Error(`${name} not found in readerHtml.ts — did it get renamed?`)
  let depth = 0
  let seenBrace = false
  let i = start
  for (; i < SOURCE.length; i++) {
    const c = SOURCE[i]
    if (c === '{') { depth++; seenBrace = true } else if (c === '}') {
      depth--
      if (seenBrace && depth === 0) { i++; break }
    }
  }
  return SOURCE.slice(start, i)
}

const SCRIPT = `${extractFunction('currentChapterBounds')}\n${extractFunction('reportProgress')}`

interface ProgressMessage {
  type: string
  progress: number
  chapterSlug: string | null
  scrollY: number
}

interface Scenario {
  /** The chapter element, in document coordinates. */
  chapter: { slug: string; top: number; height: number } | null
  scrollY: number
  innerHeight: number
  scrollHeight: number
  text?: string
}

/** Runs the extracted reporter once and returns the message it posted, if any. */
function report(s: Scenario): ProgressMessage | null {
  const sent: ProgressMessage[] = []
  const ctx: Record<string, unknown> = {
    tsChapter: s.chapter && {
      slug: s.chapter.slug,
      el: {
        getBoundingClientRect: () => ({
          top: s.chapter!.top - s.scrollY,
          bottom: s.chapter!.top + s.chapter!.height - s.scrollY,
        }),
      },
    },
    window: {
      scrollY: s.scrollY,
      innerHeight: s.innerHeight,
      ReactNativeWebView: { postMessage: (m: string) => sent.push(JSON.parse(m)) },
    },
    document: {
      documentElement: { scrollHeight: s.scrollHeight },
      body: { innerText: s.text ?? 'a chapter with real prose in it' },
    },
    // The shipped script keeps this in an enclosing scope; -1 guarantees the
    // 0.005 delta gate opens so a single call always reports.
    lastProgress: -1,
    isFinite,
    Math,
    JSON,
  }
  // eslint-disable-next-line no-new-func
  new Function('ctx', `with (ctx) { ${SCRIPT}; reportProgress(); }`)(ctx)
  return sent[0] ?? null
}

const VIEWPORT = 800
const ch = (slug: string, top: number, height: number) => ({ slug, top, height })

describe('reader progress reporter', () => {
  it('reports 0 at the top and 1 at the bottom', () => {
    expect(report({ chapter: ch('one', 0, 3000), scrollY: 0, innerHeight: VIEWPORT, scrollHeight: 3000 }))
      .toMatchObject({ progress: 0, chapterSlug: 'one', scrollY: 0 })
    expect(report({ chapter: ch('one', 0, 3000), scrollY: 2200, innerHeight: VIEWPORT, scrollHeight: 3000 }))
      .toMatchObject({ progress: 1, chapterSlug: 'one' })
  })

  it('treats a chapter shorter than the viewport as read', () => {
    expect(report({ chapter: ch('one', 0, 500), scrollY: 0, innerHeight: VIEWPORT, scrollHeight: VIEWPORT }))
      .toMatchObject({ progress: 1 })
  })

  it('reports nothing at all for an empty chapter', () => {
    // Restoring a saved position calls scrollTo, which fires this listener. A
    // blank chapter would otherwise bank 100% into the book-wide percent
    // without the user reading a word.
    expect(report({
      chapter: ch('one', 0, 0), scrollY: 0, innerHeight: VIEWPORT, scrollHeight: VIEWPORT, text: '   \n  ',
    })).toBeNull()
  })

  it('reaches 1 at the end of the chapter text, not at the end of the block below it', () => {
    // The end-of-chapter block adds ~400px under the chapter. Measured against
    // the document, the reader standing at the last line would read ~85%.
    expect(report({ chapter: ch('one', 0, 3000), scrollY: 2200, innerHeight: VIEWPORT, scrollHeight: 3400 }))
      .toMatchObject({ progress: 1, chapterSlug: 'one' })
    expect(report({ chapter: ch('one', 0, 3000), scrollY: 2600, innerHeight: VIEWPORT, scrollHeight: 3400 }))
      .toMatchObject({ progress: 1 })
  })

  it('reports a chapter-relative offset when the chapter sits below the page padding', () => {
    const msg = report({ chapter: ch('one', 52, 3000), scrollY: 1052, innerHeight: VIEWPORT, scrollHeight: 3452 })
    expect(msg?.scrollY).toBe(1000)
  })

  it('stays inside 0..1 and is monotonic as the reader scrolls forward', () => {
    let prev = 0
    for (let y = 0; y <= 2600; y += 100) {
      const msg = report({ chapter: ch('one', 0, 3000), scrollY: y, innerHeight: VIEWPORT, scrollHeight: 3400 })!
      expect(msg.progress).toBeGreaterThanOrEqual(prev)
      expect(msg.progress).toBeLessThanOrEqual(1)
      prev = msg.progress
    }
  })
})
