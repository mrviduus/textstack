import { describe, it, expect } from 'vitest'
import { openEnginePage } from '../test/enginePage'
import { buildEngineReaderHtml } from './readerHtml'

/**
 * The progress the engine page reports (`place()` in readerEnginePage.ts), on the real page.
 *
 * What it locks down: React Native feeds this value to `computeBookProgress()` as the WITHIN-CHAPTER
 * fraction, so it must be measured against the chapter element — not the document, which also holds
 * the end-of-chapter block (and, until 2026-10-03, appended chapters: the book percent ran backwards
 * every time one landed). The scroll offset is chapter-relative for the same reason.
 *
 * jsdom has no layout: the chapter's box, the scroll and the viewport are stubbed.
 */

const VIEWPORT = 800
type Layout = { top: number; height: number }

async function page(html = '<p>A chapter with real prose in it.</p>') {
  const p = await openEnginePage(html)
  const w = p.w as unknown as { scrollY: number; innerHeight: number }
  const layout: Layout = { top: 0, height: 0 }
  Object.defineProperty(p.w, 'innerHeight', { configurable: true, value: VIEWPORT })
  Object.defineProperty(p.w, 'scrollY', { configurable: true, writable: true, value: 0 })
  // The engine reads the scroll off the page's scroller.
  Object.defineProperty(p.w.document.documentElement, 'scrollTop', { configurable: true, get: () => w.scrollY, set: (v: number) => { w.scrollY = v } })
  const chapter = p.root.firstElementChild as HTMLElement
  chapter.getBoundingClientRect = () => ({ top: layout.top - w.scrollY, bottom: layout.top + layout.height - w.scrollY } as DOMRect)
  /** Scrolls to `scrollY` with the chapter laid out at `l`; the progress the page reports, or null. */
  const at = async (l: Layout, scrollY: number) => {
    Object.assign(layout, l)
    w.scrollY = scrollY
    p.messages.length = 0
    p.w.dispatchEvent(new p.w.Event('scroll'))
    p.w.document.dispatchEvent(new p.w.Event('scroll'))
    await p.settle()
    return (p.messages.filter((m) => m.type === 'progress').at(-1) ?? null) as { progress: number; scrollY: number } | null
  }
  return { ...p, at }
}

describe('engine page progress', () => {
  it('reports 0 at the top and 1 at the bottom of the chapter', async () => {
    const p = await page()
    const ch = { top: 0, height: 5000 }
    expect((await p.at(ch, 2100))!.progress).toBeCloseTo(0.5)
    expect((await p.at(ch, 4200))!.progress).toBe(1)
    expect((await p.at(ch, 0))!.progress).toBe(0)
  })

  it('reaches 1 at the end of the chapter text, not at the end of the block below it', async () => {
    const p = await page()
    // The chapter-end block sits below the chapter: the document is taller, the chapter is what counts.
    const ch = { top: 0, height: 3000 }
    await p.at(ch, 1000)
    expect((await p.at(ch, 3000 - VIEWPORT))!.progress).toBe(1)
  })

  it('reports a chapter-relative offset when the chapter sits below the page padding', async () => {
    const p = await page()
    const r = (await p.at({ top: 120, height: 5000 }, 1120))!
    expect(r.scrollY).toBe(1000)
    expect(r.progress).toBeCloseTo(1000 / (5000 - VIEWPORT))
  })

  it('treats a chapter shorter than the viewport as read', async () => {
    // jsdom lays nothing out: the chapter is 0 px tall, shorter than the screen. The open's report says read.
    const p = await openEnginePage('<p>A short chapter.</p>')
    expect(p.messages.filter((m) => m.type === 'progress').at(-1)).toMatchObject({ progress: 1 })
  })

  it('a saved offset is restored in the same space the report wrote it (chapter-relative)', async () => {
    const p = await page()
    const ch = { top: 52, height: 3000 }   // below the page padding
    await p.at(ch, 500)
    p.messages.length = 0
    p.call('__textstackRestoreScroll(1200, 5)')
    await p.settle()
    expect(p.messages.find((m) => m.type === 'restored')).toMatchObject({ restoreId: 5, scrollY: 1200 })
  })

  it('the document never makes scrolling smooth (it turned every restore into an animation, acked before it landed)', () => {
    expect(buildEngineReaderHtml('<p>x</p>')).not.toMatch(/scroll-behavior:\s*smooth/)
  })

  it('reports nothing at all for an empty chapter', async () => {
    const p = await openEnginePage('<p>   </p>')
    expect(p.messages.filter((m) => m.type === 'progress')).toEqual([])
  })
})

