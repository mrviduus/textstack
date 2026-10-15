import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openEnginePage, HELD_MS, SETTLED_MS } from '../test/enginePage'

// TR-1: the shared fixture, also read by the engine's own rule test (packages/reader-engine sentence.test.ts, E48).
// `tag`: the word's block element (default p); `selectThroughGloss`: a drag selection, not a hold.
// `html` carries the old page's inline gloss span; on the engine page a gloss is drawn by markVocabWords
// (never in the chapter text), so the span is taken out and the glossed word marked instead.
type Case = { name: string; text: string; html?: string; tag?: string; selectThroughGloss?: boolean; offset: number; word: string; expected: string }
const cases: Case[] = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../packages/shared/src/text/__fixtures__/sentences.json'), 'utf8'),
)
const GLOSS = /<span class="vocab-inline-translation">(.*?)<\/span>/

/** The engine page on the case's paragraph; the word's own text node. */
async function pageFor(c: Case) {
  const gloss = c.html ? GLOSS.exec(c.html) : null
  const content = (c.html ?? c.text).replace(GLOSS, '')
  const tag = c.tag ?? 'p'
  const page = await openEnginePage(`<${tag}>${content}</${tag}><p>Next paragraph.</p>`)
  if (gloss) page.call(`markVocabWords(${JSON.stringify({ [c.word.toLowerCase()]: { stage: 0, translation: gloss[1] } })})`)
  const node = page.root.querySelector(tag)!.firstChild as Text
  return { page, node }
}

const lastSelection = (page: Awaited<ReturnType<typeof openEnginePage>>) =>
  page.messages.filter((m) => m.type === 'selection').at(-1) as { text: string; sentence: string } | undefined

/** TR-1: the real engine page, driven by a hold, sends the sentence of the TAPPED occurrence. */
async function hold(c: Case) {
  const { page, node } = await pageFor(c)
  ;(page.w as unknown as { __caret: () => Range }).__caret = () => { const r = page.w.document.createRange(); r.setStart(node, c.offset + 1); return r }
  node.parentElement!.dispatchEvent(new page.w.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 1, clientY: 1 }))
  await new Promise((r) => setTimeout(r, HELD_MS))
  return lastSelection(page)
}

/** A drag selection over the word, the selectionchange path. */
async function drag(c: Case) {
  const { page, node } = await pageFor(c)
  const r = page.w.document.createRange()
  r.setStart(node, c.offset)
  r.setEnd(node, c.offset + c.word.length)
  page.w.document.getSelection()!.addRange(r)
  page.w.document.dispatchEvent(new page.w.Event('selectionchange'))
  await new Promise((res) => setTimeout(res, SETTLED_MS))
  return lastSelection(page)
}

describe('TR-1: the engine page sends the sentence of the selected word', () => {
  it.each(cases)('TR-1 shared fixture: $name', async (c) => {
    const msg = c.selectThroughGloss ? await drag(c) : await hold(c)
    expect(msg?.text).toBe(c.word)
    expect(msg?.sentence).toBe(c.expected)
  })
})
