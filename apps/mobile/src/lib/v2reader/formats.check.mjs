// The format check (#1128): the committed page, in Chromium under the Android host's origin (bookOriginRoute.mjs), opens one
// small book per format (fixtures.mjs writeFormatFixtures) and must answer as README "Formats" says:
// each format reader runs only when its first book opens, CBZ has no text features and still saves and
// restores its page, a fraction-only position (#1187) restores without saving, a synthetic KF8 (#1182) reads,
// a DRM-flagged MOBI or KF8, a damaged KF8 and an unknown file are refused, and flow() switches the live view
// and is reported once per book in `telemetry`; a selection reaches the host as one `selection` (#1268). PDF (#1128 S5): opens through pdf.js on the page's main
// thread, pages, selects, saves and resumes by `pdf-page`, a password-protected one fails leaving the open
// book reading, and a hostile PDF neither runs script nor leaves the file.
//
//   node --experimental-strip-types formats.check.mjs      (pnpm -C apps/web check:v2-reader-formats)
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAGE_URL, bookAt, routeBookOrigin } from './bookOriginRoute.mjs'
import { fb2, hostilePdf, pdf, writeFormatFixtures } from './fixtures.mjs'
import { v2ReaderAndroidPageHtml as v2ReaderPageHtml } from './v2ReaderPage.generated.ts'

const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = createRequire(resolve(here, '../../../../web/package.json'))('@playwright/test')
const TIMEOUT_MS = 15000
// The hosts' validator, as they run it. Bundled first (apps/web's esbuild, as build.mjs): selection.mjs imports
// packages/shared, whose extensionless TS imports plain node does not resolve.
const { build: esbuild } = createRequire(resolve(here, '../../../../web/package.json'))('esbuild')
const bundled = await esbuild({ entryPoints: [resolve(here, 'selection.mjs')], bundle: true, write: false, format: 'esm', logLevel: 'silent' })
const { readSelection } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

const failures = []
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); if (!ok) failures.push(what) }

const dir = mkdtempSync(resolve(tmpdir(), 'ts-v2-formats-'))
const browser = await chromium.launch()
/** A page with the book origin routed to `dir`, as the Android interceptor serves it. */
const newPage = async (opts) => { const p = await browser.newPage(opts); await routeBookOrigin(p, dir); return p }
try {
  writeFormatFixtures(dir)
  for (const f of ['tssynthetic-kf8.azw3', 'tssynthetic-combo.mobi']) copyFileSync(resolve(here, 'synthetic', f), resolve(dir, f))
  writeFileSync(resolve(dir, 'tsplain.txt'), 'plain text, no book')
  writeFileSync(resolve(dir, 'page.html'), v2ReaderPageHtml(randomBytes(18).toString('base64')))
  const page = await newPage()
  const messages = []
  page.on('pageerror', (e) => check(false, `pageerror: ${e.message}`))
  await page.exposeFunction('__toHost', (json) => messages.push(JSON.parse(json)))
  await page.addInitScript(() => { if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) } })
  // Every CSP violation in any frame of the page, as `directive blockedURI`.
  await page.addInitScript(() => addEventListener('securitypolicyviolation', (e) => (top.__violations ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)))
  await page.goto(PAGE_URL)

  /** The first message from `from` on that matches. */
  const waitFor = async (from, match, what) => {
    for (const t0 = Date.now(); Date.now() - t0 < TIMEOUT_MS; await page.waitForTimeout(50)) {
      const m = messages.slice(from).find(match)
      if (m) return m
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const call = (js) => page.evaluate(js)
  const loaded = () => call('Object.keys(window.__tsFormats).sort().join(",")')
  /** Opens `file`; resolves with `opened` or `open-failed`, after `restored` for an opened book. */
  const open = async (file, stored = null) => {
    const from = messages.length
    await call(`window.__fol.openUrl(${JSON.stringify(bookAt(file))}, ${JSON.stringify(file)})`)
    const m = await waitFor(from, (x) => (x.type === 'opened' || x.type === 'open-failed') && (x.book?.name ?? x.name) === file, `${file} to open`)
    if (m.type === 'opened') {
      await call(`window.__fol.restore(${JSON.stringify(stored)})`)
      m.restored = await waitFor(from, (x) => x.type === 'restored', `${file} restored`)
    }
    return { ...m, from }
  }
  /** Polls the section frames (blob:) until one passes `probe`, run inside it. */
  const shown = async (probe) => {
    for (const t0 = Date.now(); Date.now() - t0 < TIMEOUT_MS; await page.waitForTimeout(100)) {
      for (const f of page.frames().filter((f) => f.url().startsWith('blob:'))) if (await f.evaluate(probe).catch(() => false)) return true
    }
    return false
  }
  const showsText = () => shown(() => document.body?.innerText.includes('Paragraph 1. Sphinx'))

  /** The shown section frame whose text includes `text`. */
  const frameWith = async (text) => {
    for (const t0 = Date.now(); Date.now() - t0 < TIMEOUT_MS; await page.waitForTimeout(100))
      for (const x of page.frames().filter((x) => x.url().startsWith('blob:')))
        if (await x.evaluate((t) => !!frameElement && frameElement.getBoundingClientRect().width > 0 && document.body?.innerText.includes(t), text).catch(() => false)) return x
    return null
  }
  /**
   * Selects in frame `f` from `a` (+`ao`) to `b` (+`bo`), the first text nodes holding them, in `steps` changes
   * 30 ms apart (a drag). Resolves with the range's box as the page viewport shows it (unscaled frame).
   */
  const select = (f, a, ao, b, bo, steps = 1) => f.evaluate(async ([a, ao, b, bo, steps]) => {
    const find = (t) => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) if (w.currentNode.data.includes(t)) return w.currentNode }
    const [na, nb] = [find(a), find(b)]
    const r = document.createRange()
    r.setStart(na, na.data.indexOf(a) + ao)
    const s = getSelection()
    for (let k = steps; k >= 1; k--) {
      r.setEnd(nb, nb.data.indexOf(b) + bo - (k - 1))
      s.removeAllRanges()
      s.addRange(r)
      await new Promise((ok) => setTimeout(ok, 30))
    }
    return r.getBoundingClientRect().toJSON()
  }, [a, ao, b, bo, steps])
  /** `box` (in `f`'s document) in the page viewport, rounded as the page rounds. */
  const inPage = async (f, box) => {
    const fr = await f.evaluate(() => frameElement.getBoundingClientRect().toJSON())
    return { x: Math.round(fr.left + box.left), y: Math.round(fr.top + box.top), w: Math.round(box.width), h: Math.round(box.height) }
  }
  /** The settle (220 ms) and some: every message one gesture makes is in by then. */
  const settled = () => page.waitForTimeout(600)
  const kinds = (from) => messages.slice(from).filter((x) => ['selection', 'selection-cleared', 'word', 'tap'].includes(x.type)).map((x) => x.type)
  /** Collapses the selection in `f` and waits for its `selection-cleared`. */
  const unselect = async (f) => {
    const from = messages.length
    await f.evaluate(() => getSelection().removeAllRanges())
    return !!(await waitFor(from, (x) => x.type === 'selection-cleared', 'selection-cleared').catch(() => null))
  }

  /**
   * #1268 on a reflowable book: a drag over "black quartz" (three selectionchanges) is one `selection` once it
   * settles, which the hosts' validator takes, with a CFI and a rect on the range in the page viewport; it is
   * sent again where a font change moved it; collapsing it is one `selection-cleared`. A click that dismisses a
   * selection is only its `selection-cleared`; a word tap is answered at once; a double-click is `word` then
   * `selection` (the selection supersedes the word).
   * Text as rendered, without the edge whitespace a drag from the blank after a heading starts in.
   */
  async function checkSelection(what) {
    const f = await frameWith('black quartz')
    if (!f) return check(false, `${what}: no section frame with text`)
    let from = messages.length
    const want = await inPage(f, await select(f, 'black quartz', 0, 'black quartz', 'black quartz'.length, 3))
    await settled()
    const v = readSelection(messages.slice(from).find((x) => x.type === 'selection'))
    const vw = await call('[innerWidth, innerHeight]')
    check(!!v && v.text === 'black quartz' && /Sphinx of black quartz, judge my vow\./.test(v.sentence) && v.tooLong === false && /^epubcfi\(/.test(v.cfi ?? '')
      && JSON.stringify(v.rect) === JSON.stringify(want) && v.rect.x >= 0 && v.rect.x + v.rect.w <= vw[0] && v.rect.y >= 0 && v.rect.y + v.rect.h <= vw[1],
    `${what}: a selection is sent and passes the host validator (${JSON.stringify(v)}, range at ${JSON.stringify(want)})`)
    check(JSON.stringify(kinds(from)) === '["selection"]', `${what}: a drag is one selection, not one per change (${kinds(from)})`)

    // A font change moves the selection: sent again where it now is.
    from = messages.length
    await call('window.__fol.font(4)')
    await page.waitForTimeout(1200)
    const moved = readSelection(messages.slice(from).findLast((x) => x.type === 'selection'))
    const now = await inPage(f, await f.evaluate(() => getSelection().getRangeAt(0).getBoundingClientRect().toJSON()))
    check(!!moved && JSON.stringify(moved.rect) === JSON.stringify(now) && JSON.stringify(now) !== JSON.stringify(want),
      `${what}: font(+4) sends the selection again at its new place (${JSON.stringify(moved?.rect)}, range at ${JSON.stringify(now)})`)
    await call('window.__fol.font(-4)')
    await page.waitForTimeout(1200)

    // A click on another word while a selection is sent: the selection ends, and that is all.
    from = messages.length
    const judge = await f.evaluate(() => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      while (w.nextNode() && !w.currentNode.data.includes('judge'));
      const r = document.createRange()
      r.setStart(w.currentNode, w.currentNode.data.indexOf('judge'))
      r.setEnd(w.currentNode, w.currentNode.data.indexOf('judge') + 5)
      const b = r.getBoundingClientRect(), fr = frameElement.getBoundingClientRect()
      return { x: fr.left + b.left + b.width / 2, y: fr.top + b.top + b.height / 2 }
    })
    await page.mouse.click(judge.x, judge.y)
    await settled()
    check(JSON.stringify(kinds(from)) === '["selection-cleared"]', `${what}: a click that dismisses the selection is only selection-cleared (${kinds(from)})`)

    // A plain word tap: answered at once, before the selection settle time (220 ms) could pass.
    from = messages.length
    const t0 = Date.now()
    await page.mouse.click(judge.x, judge.y)
    const tapWord = await waitFor(from, (x) => x.type === 'word', `${what}: word`).catch(() => null)
    const ms = Date.now() - t0
    check(tapWord?.word === 'judge' && ms < 150, `${what}: a word tap is answered at once (${tapWord?.word}, ${ms} ms)`)
    await settled()
    // A double-click selecting a word: the tap's word, then the selection that supersedes it.
    from = messages.length
    await page.mouse.dblclick(judge.x, judge.y)
    await settled()
    const dbl = messages.slice(from).find((x) => x.type === 'selection')
    check(JSON.stringify(kinds(from)) === '["word","selection"]' && dbl?.text === 'judge', `${what}: a double-click on a word is word then selection (${kinds(from)}, ${dbl?.text})`)
    check(await unselect(f), `${what}: a collapsed selection is selection-cleared`)

    // From the heading's end (the blank after it) into the paragraph: text and sentence are the paragraph's.
    from = messages.length
    await select(f, 'Chapter One', 'Chapter One'.length, 'Paragraph 1.', 'Paragraph 1.'.length)
    await settled()
    const edge = readSelection(messages.slice(from).find((x) => x.type === 'selection'))
    check(edge?.text === 'Paragraph 1.' && /^Paragraph 1\./.test(edge.sentence), `${what}: a drag from the blank after a heading is the paragraph's (${edge?.text} / ${edge?.sentence})`)
    // Across blocks: the words stay apart, as on screen.
    from = messages.length
    await select(f, 'Chapter One', 0, 'Paragraph 1.', 'Paragraph 1.'.length)
    await settled()
    const across = readSelection(messages.slice(from).find((x) => x.type === 'selection'))
    check(/^Chapter One\s+Paragraph 1\.$/.test(across?.text ?? ''), `${what}: a selection across blocks keeps its words apart (${JSON.stringify(across?.text)})`)
    check(await unselect(f), `${what}: and is cleared`)
  }

  /** The center of the first `word` in frame `f`, in the page viewport (unscaled frame). */
  const wordAt = (f, word) => f.evaluate((word) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (w.nextNode() && !w.currentNode.data.includes(word));
    const r = document.createRange()
    r.setStart(w.currentNode, w.currentNode.data.indexOf(word))
    r.setEnd(w.currentNode, w.currentNode.data.indexOf(word) + word.length)
    const b = r.getBoundingClientRect(), fr = frameElement.getBoundingClientRect()
    return { x: fr.left + b.left + b.width / 2, y: fr.top + b.top + b.height / 2 }
  }, word)
  /** Wraps the `n`th `word` (from 0) of frame `f` in a span and returns its element handle: Playwright's box is the truth. */
  const wrapWord = async (f, word, n = 0) => {
    await f.evaluate(([word, n]) => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let k = -1
      while (w.nextNode()) if (w.currentNode.data.includes(word) && ++k === n) break
      const r = document.createRange()
      r.setStart(w.currentNode, w.currentNode.data.indexOf(word))
      r.setEnd(w.currentNode, w.currentNode.data.indexOf(word) + word.length)
      const span = document.createElement('span')
      span.className = 'ts-truth'
      r.surroundContents(span)
    }, [word, n])
    return (await f.$$('.ts-truth')).at(-1)
  }
  const near = (rect, box, px = 1) => !!rect && !!box && Math.abs(rect.x - box.x) <= px && Math.abs(rect.y - box.y) <= px && Math.abs(rect.w - box.width) <= px && Math.abs(rect.h - box.height) <= px

  /**
   * #1268 re-review: the edges of the selection rule, each a row that failed before its fix.
   */
  async function checkSelectionEdges() {
    console.log('selection edges')
    const lastSel = (from) => messages.slice(from).filter((x) => x.type === 'selection').at(-1)

    // 1+7. A wide paginated view shows two columns in a box narrower than the window: a selection turned onto
    // the hidden next page is cleared, and the next tap is a word, not swallowed.
    await page.setViewportSize({ width: 1700, height: 900 })
    call('window.__fol.flow("paginated")')
    let m = await open('tsformat.epub')
    let f = await frameWith('black quartz')
    let from = messages.length
    await select(f, 'black quartz', 0, 'black quartz', 'black quartz'.length)
    await settled()
    check(!!readSelection(lastSel(from)), 'wide paginated: a selection is sent')
    from = messages.length
    await call('window.__fol.next()')
    await page.waitForTimeout(1200)
    check(kinds(from).join() === 'selection-cleared', `wide paginated: a page turned away from it clears it (${kinds(from)}; ${JSON.stringify(lastSel(from)?.rect)})`)
    f = await frameWith('Paragraph')
    const vis = await f.evaluate(() => {
      // A word on the page shown: the first text whose box is inside the paginator's column area.
      const fr = frameElement.getBoundingClientRect()
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      while (w.nextNode()) {
        const n = w.currentNode, i = n.data.indexOf('quartz')
        if (i < 0) continue
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 6)
        const b = r.getBoundingClientRect()
        const x = fr.left + b.left + b.width / 2
        if (x > innerWidth * 0.25 && x < innerWidth * 0.75) return { x, y: fr.top + b.top + b.height / 2 }
      }
    })
    // A selection on the spread shown, then the spread before it: the selection is on the next, hidden spread,
    // inside the window but outside the paginator's column box.
    from = messages.length
    if (vis) await page.mouse.dblclick(vis.x, vis.y)
    await settled()
    check(lastSel(from)?.text === 'quartz', `wide paginated: a selection on the second spread is sent (${lastSel(from)?.text})`)
    from = messages.length
    await call('window.__fol.prev()')
    await page.waitForTimeout(1200)
    check(kinds(from).join() === 'selection-cleared', `wide paginated: turned back, the selection on the hidden spread is cleared (${kinds(from)}; ${JSON.stringify(lastSel(from)?.rect)})`)
    const first = await wordAt(f, 'judge')
    from = messages.length
    await page.mouse.click(first.x, first.y)
    await settled()
    check(kinds(from).join() === 'word', `wide paginated: the next tap is a word (${kinds(from)})`)

    // 7. Select-all in a long scrolled section: sent, inside the validator's bounds (the visible part).
    call('window.__fol.flow("scrolled")')
    await page.waitForTimeout(1200)
    f = await frameWith('black quartz')
    from = messages.length
    await f.evaluate(() => getSelection().selectAllChildren(document.body))
    await settled()
    const all = readSelection(lastSel(from))
    check(!!all && all.rect.y >= 0 && all.rect.y + all.rect.h <= 900, `select-all in a long section reaches the host, its visible part (${JSON.stringify(lastSel(from)?.rect)})`)
    await unselect(f)

    // 3. A word deep in a long scrolled chapter, at a width whose layout is fractional: its rect is where it is drawn.
    await page.setViewportSize({ width: 1001, height: 700 })
    // A fractional layout width, as an Android WebView has at a fractional device pixel ratio.
    await call(`document.querySelector('foliate-view')?.remove(); document.body.style.width = '1000.4px'`)
    m = await open('tsformat.epub')
    call('window.__fol.flow("scrolled")')
    await page.waitForTimeout(800)
    // Deep into the chapter by scrolling (a `next` past the last section is foliate's navigation error).
    await page.mouse.move(500, 350)
    for (let k = 0; k < 6; k++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(200) }
    await page.waitForTimeout(800)
    f = await frameWith('Paragraph')
    const deep = await f.evaluate(() => {
      const fr = frameElement.getBoundingClientRect()
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let k = -1
      while (w.nextNode()) {
        const n = w.currentNode, i = n.data.indexOf('lazy')
        if (i < 0) continue
        k++
        const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 4)
        const b = r.getBoundingClientRect(), y = fr.top + b.top
        if (y > 100 && y < innerHeight - 100) return { k, fw: fr.width, ow: frameElement.offsetWidth }
      }
    })
    const truth = deep && await wrapWord(f, 'lazy', deep.k)
    const tb = await truth?.boundingBox()
    from = messages.length
    if (tb) await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2)
    const w = await waitFor(from, (x) => x.type === 'word', 'deep word').catch(() => null)
    check(w?.word === 'lazy' && near(w.rect, tb), `a word deep in a scrolled chapter is placed where it is drawn (frame ${deep?.fw} vs ${deep?.ow}; ${JSON.stringify(w?.rect)} vs ${JSON.stringify(tb)})`)

    // 6. A click held 300 ms (past the settle time) while a selection is sent: only its selection-cleared.
    await call(`document.body.style.width = ''`)
    await page.setViewportSize({ width: 1280, height: 720 })
    m = await open('tsformat.epub')
    f = await frameWith('black quartz')
    await select(f, 'black quartz', 0, 'black quartz', 'black quartz'.length)
    await settled()
    const judge = await wordAt(f, 'judge')
    from = messages.length
    await page.mouse.move(judge.x, judge.y)
    await page.mouse.down()
    await page.waitForTimeout(300)
    await page.mouse.up()
    await settled()
    check(kinds(from).join() === 'selection-cleared', `a click held 300 ms that dismisses the selection is only selection-cleared (${kinds(from)})`)

    // 8. A double-click's selection highlighted: exactly the text and CFI the host was shown.
    from = messages.length
    await page.mouse.dblclick(judge.x, judge.y)
    await settled()
    const shown = readSelection(lastSel(from))
    from = messages.length
    call('window.__fol.highlightSelection()')
    const hl = await waitFor(from, (x) => x.type === 'highlighted', 'highlighted').catch(() => null)
    check(!!shown && hl?.selectedText === shown.text && hl.cfi === shown.cfi, `a highlight is the selection sent (${JSON.stringify([shown?.text, shown?.cfi])} vs ${JSON.stringify([hl?.selectedText, hl?.cfi])})`)
    await settled()
    // The same with a trailing space in the selection (a platform's word selection may take it).
    f = await frameWith('black quartz')
    from = messages.length
    await select(f, 'judge', 0, 'judge', 'judge '.length)
    await settled()
    const spaced = readSelection(lastSel(from))
    from = messages.length
    call('window.__fol.highlightSelection()')
    const hl2 = await waitFor(from, (x) => x.type === 'highlighted', 'highlighted').catch(() => null)
    check(spaced?.text === 'judge' && hl2?.selectedText === spaced.text && hl2.cfi === spaced.cfi,
      `a highlight of a selection with a trailing space is the selection sent (${JSON.stringify([spaced?.text, spaced?.cfi])} vs ${JSON.stringify([hl2?.selectedText, hl2?.cfi])})`)
    await settled()
    // Source whitespace the screen collapses: 2,000 characters shown, 5,600 in the text the highlight keeps.
    // The highlight would refuse it, so the selection sent has no CFI.
    from = messages.length
    await f.evaluate(() => {
      const p = document.createElement('p')
      p.textContent = ('word' + ' '.repeat(10)).repeat(400)
      document.body.prepend(p)
      getSelection().selectAllChildren(p)
    })
    await settled()
    const wide = readSelection(lastSel(from))
    from = messages.length
    call('window.__fol.highlightSelection()')
    await page.waitForTimeout(400)
    const refused = messages.slice(from).some((x) => x.type === 'log' && /over 4000/.test(x.msg))
    check(!!wide && wide.cfi === null && refused, `a selection the highlight refuses is sent without a CFI (${wide?.text.length} shown, cfi ${wide?.cfi}; refused ${refused})`)
    await f.evaluate(() => document.body.firstElementChild.remove())
    await settled()

    // 9. A relocate with the same selection recomputes its box only: no CFI, text or sentence again.
    f = await frameWith('black quartz')
    from = messages.length
    await select(f, 'black quartz', 0, 'black quartz', 'black quartz'.length)
    await settled()
    // Counted for the selection's range only: foliate's own relocate computes its CFI through getCFI too.
    await call(`(() => { const v = document.querySelector('foliate-view'), g = v.getCFI.bind(v); window.__cfiCalls = 0; v.getCFI = (i, r) => ((r?.toString() === 'black quartz' && window.__cfiCalls++), g(i, r)) })()`)
    from = messages.length
    await call('window.__fol.font(2)')
    await page.waitForTimeout(1200)
    const calls = await call('window.__cfiCalls')
    check(!!lastSel(from) && calls === 0, `a re-send after a font change computes no CFI again (${calls} calls; ${kinds(from)})`)
    await call('window.__fol.font(-2)')
    await page.waitForTimeout(800)

    // 5. Scrolled: after an anchored re-layout, the first scroll still moves the selection's box.
    call('window.__fol.flow("scrolled")')
    await page.waitForTimeout(800)
    from = messages.length
    await call('window.__fol.font(2)')
    await page.waitForTimeout(1200)
    const before = lastSel(from)
    from = messages.length
    await page.mouse.move(640, 400)
    await page.mouse.wheel(0, 60)
    await page.waitForTimeout(1200)
    const after = lastSel(from)
    check(!!before && !!after && after.rect.y < before.rect.y, `scrolled: the first scroll after a font change moves the selection (${before?.rect?.y} -> ${after?.rect?.y})`)
    await call('window.__fol.font(-2)')
    await unselect(f)
    call('window.__fol.flow("paginated")')

    // 2+4+6 and 5 on a spread of two frames (tsfixed.epub, pages 2 and 3).
    m = await open('tsfixed.epub')
    m = await open('tsfixed.epub', JSON.stringify({ v: 1, book: m.book, highlights: [], position: null }))
    await settled()
    await call('window.__fol.next()')
    const [f2, f3] = [await frameWith('Page 2. Sphinx'), await frameWith('Page 3. Sphinx')]
    if (!f2 || !f3) return check(false, 'spread: pages 2 and 3 shown')
    await settled()
    // A newer selection in the other frame is the one reported, and the first frame's is gone.
    from = messages.length
    await select(f2, 'black quartz', 0, 'black quartz', 'black quartz'.length)
    await settled()
    await select(f3, 'judge', 0, 'judge', 5)
    await settled()
    const newer = lastSel(from)
    const f2Left = await f2.evaluate(() => getSelection().toString())
    check(newer?.text === 'judge' && newer.index === 2 && f2Left === '', `spread: a newer selection in the other frame is the one (${newer?.text}, ${newer?.index}; left in the first: ${JSON.stringify(f2Left)})`)
    // A tap in the other frame dismisses it (only selection-cleared); the tap after is a word.
    const q2 = await wordAt(f2, 'quick')
    from = messages.length
    await page.mouse.click(q2.x, q2.y)
    await settled()
    check(kinds(from).join() === 'selection-cleared', `spread: a tap in the other frame dismisses the selection (${kinds(from)})`)
    from = messages.length
    await page.mouse.click(q2.x, q2.y)
    await settled()
    check(kinds(from).join() === 'word', `spread: and the next tap there is a word (${kinds(from)})`)
    // 5. A resize re-scales the pages with no relocate: the selection is sent again where it is drawn.
    const truthSpan = await wrapWord(f3, 'judge')
    await f3.evaluate(() => getSelection().selectAllChildren(document.querySelector('.ts-truth')))
    await settled()
    from = messages.length
    await page.setViewportSize({ width: 1100, height: 640 })
    await page.waitForTimeout(1200)
    const resized = readSelection(lastSel(from))
    const rb = await truthSpan.boundingBox()
    check(near(resized?.rect, rb), `spread: a resize sends the selection again where it is drawn (${JSON.stringify(resized?.rect)} vs ${JSON.stringify(rb)})`)
    await unselect(f3)
    await page.setViewportSize({ width: 1280, height: 720 })
  }

  /**
   * #1268 on a paginated book: a selection turned off the page is cleared, and sent again where it is when
   * turned back; a selection held when another book swaps in is cleared then, before that book's `opened`.
   */
  async function checkSelectionPaged(what, nextFile) {
    const f = await frameWith('black quartz')
    if (!f) return check(false, `${what}: no section frame with text`)
    let from = messages.length
    const want = await inPage(f, await select(f, 'black quartz', 0, 'black quartz', 'black quartz'.length))
    await settled()
    check(!!readSelection(messages.slice(from).find((x) => x.type === 'selection')), `${what}: a selection is sent`)
    from = messages.length
    await call('window.__fol.next()')
    await page.waitForTimeout(1200)
    check(kinds(from).join() === 'selection-cleared', `${what}: a page turned away from it clears it (${kinds(from)})`)
    from = messages.length
    await call('window.__fol.prev()')
    await page.waitForTimeout(1200)
    const back = readSelection(messages.slice(from).find((x) => x.type === 'selection'))
    check(!!back && JSON.stringify(back.rect) === JSON.stringify(want), `${what}: turned back, it is sent again where it is (${JSON.stringify(back?.rect)} vs ${JSON.stringify(want)})`)
    from = messages.length
    const m = await open(nextFile)
    const order = messages.slice(from).filter((x) => x.type === 'selection-cleared' || x.type === 'opened').map((x) => x.type)
    check(m.type === 'opened' && order[0] === 'selection-cleared' && order.filter((x) => x === 'selection-cleared').length === 1, `${what}: the next book's swap clears it, before opened (${order})`)
    return m
  }

  /**
   * PDF (#1128 S5): opens through pdf.js run on the page's main thread, under the unchanged CSP; pages;
   * selects; saves `{ page }` (pdf-page, section index + 1) and resumes there; refuses the other position
   * kinds; a password-protected PDF fails and the open book keeps reading; a hostile PDF neither runs
   * script nor leaves the file. In a portrait view, as on a phone.
   */
  async function checkPdf() {
    console.log('pdf')
    await page.setViewportSize({ width: 420, height: 760 })
    const violations = () => call('window.__violations ?? []')
    const before = (await violations()).length
    const settle = () => page.waitForTimeout(1200)
    const storesFrom = (from) => messages.slice(from).filter((x) => x.type === 'store').map((x) => JSON.parse(x.json).position)
    const t0 = Date.now()
    let m = await open('tsformat.pdf')
    check(m.type === 'opened' && m.format === 'pdf' && m.textual === true && m.annotatable === false && m.reflowable === false && m.sections === 5 && m.title === 'TS PDF',
      `opened as pdf: 5 pages, fixed layout, textual, not annotatable (${m.format}, ${m.sections}, ${m.annotatable}, ${m.title}${m.error ? `, ${m.error}` : ''}) in ${Date.now() - t0} ms`)
    check((await loaded()).split(',').includes('pdf'), 'the PDF reader ran on the first PDF')
    const textLayer = (n) => shown(new Function(`return !!document.querySelector('.textLayer')?.textContent.includes('Page ${n}. Sphinx')`))
    check(await textLayer(1), 'page 1 is drawn with a text layer')
    /** The section frame on screen. */
    const frame = async () => {
      for (const f of page.frames().filter((f) => f.url().startsWith('blob:')))
        if (await f.evaluate(() => getComputedStyle(frameElement.parentElement).display !== 'none' && !!document.querySelector('.textLayer span')).catch(() => false)) return f
    }
    // A selection in the text layer, as a long-press makes one.
    let f1 = await frame()
    const selected = await f1?.evaluate(() => { const s = getSelection(); s.selectAllChildren(document.querySelector('.textLayer')); return s.toString() })
    check(/Sphinx of black quartz/.test(selected ?? ''), 'its text layer selects')
    const pdfSel = readSelection(await waitFor(0, (x) => x.type === 'selection' && /Page 1\. Sphinx/.test(x.text), 'pdf selection').catch(() => null))
    check(pdfSel?.cfi === null && pdfSel.rect.w > 0 && /vow\.\s+The quick/.test(pdfSel.text),
      `the selection reaches the host, without a CFI, its lines apart (${JSON.stringify(pdfSel)})`)
    // A fixed-layout page holding the selection turned away: its frame is gone, the selection cleared.
    let turned = messages.length
    await call('window.__fol.next()')
    check(!!(await waitFor(turned, (x) => x.type === 'selection-cleared', 'pdf selection cleared by a page turn').catch(() => null)), 'a page turned away from the selection clears it')
    turned = messages.length
    await call('window.__fol.prev()')
    await waitFor(turned, (x) => x.type === 'relocate' && x.index === 0, 'back on page 1')
    await textLayer(1)
    f1 = await frame()
    let from = messages.length
    call('window.__fol.highlightSelection()')
    await waitFor(from, (x) => x.type === 'log' && /no highlights on a PDF yet/.test(x.msg), 'pdf highlight refused')
    check(!messages.slice(from).some((x) => x.type === 'store'), 'highlightSelection is refused on a PDF (no pdf-page anchor yet), nothing stored')
    // A tap on a word: the word and its sentence, no CFI (nothing can be drawn at one on a PDF).
    await f1?.evaluate(() => getSelection().removeAllRanges())
    from = messages.length
    const at = f1 && await f1.evaluate(() => {
      const r = document.querySelector('.textLayer span').getBoundingClientRect()
      const fr = frameElement.getBoundingClientRect()
      return { x: fr.left + r.left + r.width * 0.3, y: fr.top + r.top + r.height / 2 }
    })
    if (at) await page.mouse.click(at.x, at.y)
    const word = await waitFor(from, (x) => x.type === 'word' || x.type === 'tap', 'a word or tap').catch(() => null)
    check(word?.type === 'word' && /\p{L}/u.test(word.word) && /Sphinx/.test(word.sentence) && word.cfi === null,
      `a tap on the text layer answers a word with its sentence and no CFI (${word?.type} ${word?.word ?? ''} ${word?.cfi})`)
    call(`window.__fol.showTranslation('epubcfi(/6/2!/4/2/1:0)', 0, 'x')`)
    from = messages.length
    call('window.__fol.next()')
    let stored = await storeFrom(from, 'a store after a page turn')
    const p = stored?.position
    check(p?.page === 2 && p.index === 1 && !('cfi' in p) && !('quote' in p), `the page turn saved { page: 2 }, no CFI, no quote (${JSON.stringify(p)})`)
    check(await textLayer(2), 'page 2 is drawn with a text layer')
    for (const step of ['next', 'next', 'prev']) { call(`window.__fol.${step}()`); await page.waitForTimeout(400) }
    await page.waitForTimeout(800)
    stored = JSON.parse(messages.filter((x) => x.type === 'store').at(-1).json)
    check(stored.position?.page === 3, `next, next, prev: page 3 saved (${JSON.stringify(stored.position)})`)
    // A PDF that needs a password fails before the teardown: the PDF on screen keeps its page, turns and saves.
    m = await open('tslocked.pdf')
    check(m.type === 'open-failed' && /password-protected/.test(m.error), `a password-protected PDF fails to open: ${m.error}`)
    from = messages.length
    call('window.__fol.next()')
    const afterLocked = await storeFrom(from, 'a store after a failed PDF open')
    check(afterLocked?.position?.page === 4 && afterLocked.book.sha256 === stored.book.sha256, `and the PDF on screen turns and saves page 4 (${JSON.stringify(afterLocked?.position)})`)
    m = await open('tsformat.pdf', JSON.stringify(stored))
    check(m.restored.position === 'restored', `reopened, the saved page is restored (${m.restored.position})`)
    check(!!(await waitFor(m.from, (x) => x.type === 'relocate' && x.index === 2, 'relocate to page 3').catch(() => null)), 'and the view shows page 3')
    check(await textLayer(3), 'page 3 is drawn')
    await page.waitForTimeout(600)
    check(storesFrom(m.from).length === 0, 'the restore saved nothing')
    const pdfBook = m.book
    // Scheme fits the file: a CFI or a fraction is never applied to a PDF, a page number never to another format.
    const pdfEntry = (position) => JSON.stringify({ v: 1, book: pdfBook, highlights: [], position })
    m = await open('tsformat.pdf', pdfEntry({ cfi: 'epubcfi(/6/4)', quote: 'Page 2', index: 1, fraction: 0.4, at: 1 }))
    check(m.restored.position === 'wrong position kind, stayed at start', `a CFI position on a PDF is not applied (${m.restored.position})`)
    m = await open('tsformat.pdf', pdfEntry({ fraction: 0.8, at: 1 }))
    check(m.restored.position === 'wrong position kind, stayed at start', `a fraction-only position on a PDF is not applied (${m.restored.position})`)
    m = await open('tsformat.pdf', pdfEntry({ page: 9, index: 8, fraction: 1, at: 1 }))
    check(m.restored.position === 'page not found, stayed at start', `a page past the end is not applied (${m.restored.position})`)
    m = await open('tsformat.fb2')
    m = await open('tsformat.fb2', JSON.stringify({ v: 1, book: m.book, highlights: [], position: { page: 2, index: 1, fraction: 0.5, at: 1 } }))
    check(m.restored.position === 'wrong position kind, stayed at start', `a page number on an FB2 is not applied (${m.restored.position})`)
    from = messages.length
    call('window.__fol.goTo({ page: 2, index: 1, fraction: 0.5, at: 2 })')
    await waitFor(from, (x) => x.type === 'log' && /wrong position kind/.test(x.msg), 'a page goTo on an FB2 ignored')
    check(true, 'a host goTo { page } on an FB2 is ignored')
    // A host goTo by page (a sync adopt): arrives, saves nothing; a CFI or fraction goTo is ignored.
    m = await open('tsformat.pdf', JSON.stringify(stored))
    await settle()
    from = messages.length
    call('window.__fol.goTo({ page: 5, index: 4, fraction: 1, at: 2 })')
    check(!!(await waitFor(from, (x) => x.type === 'relocate' && x.index === 4, 'relocate to page 5').catch(() => null)), 'a host goTo { page: 5 } arrives')
    await settle()
    check(storesFrom(from).length === 0, 'and saves nothing')
    for (const target of [{ cfi: 'epubcfi(/6/4)', quote: 'Page 2', index: 1, fraction: 0.4, at: 3 }, { fraction: 0.2, at: 3 }, 'epubcfi(/6/6!/4/2/1:0)']) {
      from = messages.length
      call(`window.__fol.goTo(${JSON.stringify(target)})`)
      await waitFor(from, (x) => x.type === 'log' && /wrong position kind/.test(x.msg), 'a wrong-kind goTo ignored')
      await page.waitForTimeout(300)
      check(!messages.slice(from).some((x) => x.type === 'relocate' || x.type === 'store'), `a host goTo ${typeof target === 'string' ? 'raw CFI' : Object.keys(target).join('+')} on a PDF is ignored: no move, no save`)
    }
    // The page holds the goTo's page as its own: the next save (a page turn back) is page 4, once.
    from = messages.length
    call('window.__fol.prev()')
    const back = await storeFrom(from, 'a store after a turn following a host goTo')
    check(back?.position?.page === 4, `the next page turn saves page 4 (${JSON.stringify(back?.position)})`)
    // Chosen (a taken offer): the page it landed on is saved, once.
    await settle()
    from = messages.length
    call('window.__fol.goTo({ page: 2, index: 1, fraction: 0.4, at: 4 }, true)')
    const chosen = await storeFrom(from, 'a store after a chosen page goTo')
    await settle()
    check(chosen?.position?.page === 2 && storesFrom(from).length === 1, `a chosen goTo { page: 2 } saves page 2, once (${JSON.stringify(storesFrom(from))})`)
    // S5 review: `restored` names its book (hosts drop one for a book they are not reading).
    m = await open('tsformat.pdf')
    check(m.restored.key === m.book.sha256, `restored carries the book's key (${m.restored.key})`)
    // A page past the end, gone to: refused as a restore refuses it; no move, no save.
    await page.waitForTimeout(600)
    from = messages.length
    call('window.__fol.goTo({ page: 99, index: 98, fraction: 1, at: 5 }, true)')
    await waitFor(from, (x) => x.type === 'log' && /page not in this book/.test(x.msg), 'a page past the end refused').catch(() => null)
    await page.waitForTimeout(600)
    check(messages.slice(from).some((x) => x.type === 'log' && /page not in this book/.test(x.msg)) && !messages.slice(from).some((x) => x.type === 'relocate' || x.type === 'store'),
      'a goTo { page: 99 } on a 5-page PDF is refused with a warn: no move, no save')
    // The text layer separates lines with <br> only: a tapped word's sentence reads across a line end with a space.
    writeFileSync(resolve(dir, 'tslines.pdf'), pdf(1, { title: 'TS LINES', lines: ['Sphinx of black quartz judges', 'my vow and the lazy fox.'] }))
    m = await open('tslines.pdf')
    check(await shown(() => !!document.querySelector('.textLayer')?.textContent.includes('quartz judges')), 'the two-line PDF is drawn with its text layer')
    const fl = await frame()
    const quartz = await fl?.evaluate(() => {
      const t = [...document.querySelectorAll('.textLayer span')].map((s) => s.firstChild).find((n) => n?.data?.includes('quartz'))
      const r = document.createRange()
      r.setStart(t, t.data.indexOf('quartz')); r.setEnd(t, t.data.indexOf('quartz') + 6)
      const b = r.getBoundingClientRect(), fr = frameElement.getBoundingClientRect()
      return { x: fr.left + b.left + b.width / 2, y: fr.top + b.top + b.height / 2 }
    })
    from = messages.length
    if (quartz) await page.mouse.click(quartz.x, quartz.y)
    const across = await waitFor(from, (x) => x.type === 'word' || x.type === 'tap', 'a word on the two-line PDF').catch(() => null)
    check(across?.word === 'quartz' && across.sentence === 'Sphinx of black quartz judges my vow and the lazy fox.',
      `a tapped word's sentence reads across the line end with a space (${across?.word}: ${JSON.stringify(across?.sentence)})`)
    // An outline with an integer-page and a dangling destination opens; its good entry goes to its page.
    writeFileSync(resolve(dir, 'tsoutline.pdf'), pdf(3, { title: 'TS OUTLINE', outline: [
      { title: 'Good', dest: (refs) => `[${refs[2]} /Fit]` },
      { title: 'Integer', dest: () => '[0 /Fit]' },
      { title: 'Dangling', dest: () => '[99 0 R /Fit]' },
    ] }))
    m = await open('tsoutline.pdf')
    check(m.type === 'opened' && m.toc?.map((t) => t.label).join() === 'Good,Integer,Dangling', `a PDF whose outline has an integer and a dangling destination opens (${m.type}${m.error ? `, ${m.error}` : ''}, ${m.toc?.map((t) => t.label)})`)
    if (m.type === 'opened') {
      from = messages.length
      call(`window.__fol.goTo(${JSON.stringify(m.toc[0].href)})`)
      check(!!(await waitFor(from, (x) => x.type === 'relocate' && x.index === 2, 'the good outline entry').catch(() => null)), 'its good entry goes to page 3')
      from = messages.length
      for (const t of m.toc.slice(1)) call(`window.__fol.goTo(${JSON.stringify(t.href)})`)
      await page.waitForTimeout(800)
      check(!messages.slice(from).some((x) => x.type === 'relocate' || (x.type === 'log' && x.level === 'error')), 'its bad entries go nowhere and throw nothing')
    }
    // (Known gap, not fixed: the fork's render() is not idempotent.) A resize re-renders the page into the same
    // text layer: its spans are appended again.
    m = await open('tsformat.pdf')
    await textLayer(1)
    const spans = async () => { const f = await frame(); return f ? f.evaluate(() => document.querySelectorAll('.textLayer span').length) : -1 }
    const spansBefore = await spans()
    await page.setViewportSize({ width: 400, height: 740 })
    await page.waitForTimeout(1200)
    const spansAfter = await spans()
    await page.setViewportSize({ width: 420, height: 760 })
    await page.waitForTimeout(800)
    console.log(`  ${spansAfter > spansBefore ? 'bug ' : 'FIXED'}  a resize re-renders the PDF page into the same text layer (spans ${spansBefore} -> ${spansAfter})`)
    if (!(spansAfter > spansBefore)) failures.push(`known bug no longer reproduces, make it a check: resize duplicates the text layer (${spansBefore} -> ${spansAfter})`)

    // A predefined cMap (CJK): the cMap chunk runs on first need, and the text draws and extracts.
    check(!(await loaded()).split(',').includes('pdfcmaps'), 'no cMap chunk has run for a Latin PDF')
    m = await open('tscjk.pdf')
    check(m.type === 'opened' && m.format === 'pdf', `a CJK PDF on a predefined cMap opens (${m.type})`)
    check(await shown(() => document.querySelector('.textLayer')?.textContent.includes('中文')), 'its text layer has the CJK text')
    check((await loaded()).split(',').includes('pdfcmaps'), 'the cMap chunk ran for it')
    const seen = (await violations()).slice(before)
    check(seen.length === 0, `no CSP violation while reading a PDF (${seen.join('; ')})`)

    console.log('pdf hostile')
    // The logging host, routed over https like the page (an http one is stopped by mixed content before the CSP
    // or any link handling could be tested). The control shows it answers a document without this page's CSP.
    const hits = []
    const evil = 'https://evil.tst:44443'
    const log = (r) => { hits.push(new URL(r.request().url()).pathname); return r.fulfill({ body: '' }) }
    await page.context().route(`${evil}/**`, log) // the context: a window a link opened is caught too
    const control = await browser.newPage()
    await control.route(`${evil}/**`, log)
    await control.evaluate((u) => fetch(u, { mode: 'no-cors' }).catch(() => {}), `${evil}/control`)
    await control.close()
    check(hits.includes('/control'), `control: the logging host is reachable (${hits.join(', ')})`)
    hits.length = 0
    try {
      writeFileSync(resolve(dir, 'tshostile.pdf'), hostilePdf(evil))
      m = await open('tshostile.pdf')
      check(m.type === 'opened' && m.format === 'pdf', `the hostile PDF opens (${m.type}${m.error ? `, ${m.error}` : ''})`)
      check(await shown(() => document.querySelectorAll('.annotationLayer section').length > 0), 'its link annotations are drawn')
      const f = await frame()
      const links = await f?.evaluate(() => [...document.querySelectorAll('.annotationLayer section')].map((s) => {
        const r = s.getBoundingClientRect()
        const fr = frameElement.getBoundingClientRect()
        return { x: fr.left + r.left + r.width / 2, y: fr.top + r.top + r.height / 2 }
      })) ?? []
      check(links.length === 5, `five link annotations drawn (${links.length})`)
      from = messages.length
      for (const l of links) { await page.mouse.click(l.x, l.y); await page.waitForTimeout(200) }
      await page.waitForTimeout(1000)
      const pwned = (await Promise.all(page.frames().map((fr) => fr.evaluate(() => !!window.__pwned).catch(() => false)))).some(Boolean)
      check(!pwned, 'no PDF script ran (OpenAction, JavaScript link, javascript: URI)')
      check(hits.length === 0, `nothing reached the logging server (${hits.join(', ')})`)
      check(page.frames().every((fr) => (fr.url() === PAGE_URL || /^(blob:|about:blank)/.test(fr.url()))), `no frame left the book (${page.frames().map((fr) => fr.url().slice(0, 30)).join(', ')})`)
      const handed = messages.slice(from).filter((x) => x.type === 'openLink').map((x) => x.href)
      // pdf.js turns a GoToR whose file is an http URL into that URL: a link like the URI one, handed to the
      // host's allowlist like any http link in an EPUB. The Launch and script ones never.
      check(handed.length === 2 && handed[0].startsWith(`${evil}/gotor.pdf`) && handed[1] === `${evil}/uri`,
        `only the two http links are handed to the host, never followed (${handed.join(', ')})`)
      const hostile = (await violations()).slice(before)
      console.log(`  info  CSP violations reported while the hostile PDF was open: ${hostile.length ? hostile.join('; ') : 'none'}`)
    } finally {
      await page.setViewportSize({ width: 1280, height: 720 })
    }
  }

  /**
   * S5 review: an older WebView. The runtime APIs pdf.js 5.5 calls that the PDF reader polyfills
   * (pdfPolyfills.mjs) are deleted before the page runs: the PDF still opens and draws. Without
   * structuredClone too (not polyfillable), the open is refused with a clear message, never left hanging.
   */
  async function checkOldWebView() {
    console.log('old WebView (S5 review)')
    // Serialised into the page by Playwright: no closure, `alsoClone` comes as its argument.
    const strip = (alsoClone) => {
      for (const [o, k] of [[Map.prototype, 'getOrInsertComputed'], [Map.prototype, 'getOrInsert'], [WeakMap.prototype, 'getOrInsertComputed'],
        [WeakMap.prototype, 'getOrInsert'], [Promise, 'withResolvers'], [Promise, 'try'], [AbortSignal, 'any'], [Array.prototype, 'findLast'],
        [Uint8Array.prototype, 'toHex'], [Uint8Array.prototype, 'toBase64'], [Uint8Array, 'fromBase64'], [ArrayBuffer.prototype, 'transferToFixedLength'],
        [URL, 'parse'], [ReadableStream.prototype, Symbol.asyncIterator]]) delete o[k]
      if (alsoClone) delete window.structuredClone
    }
    for (const alsoClone of [false, true]) {
      const old = await newPage({ viewport: { width: 420, height: 760 } })
      const got = []
      await old.exposeFunction('__toHost', (json) => got.push(JSON.parse(json)))
      await old.addInitScript(() => { if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) } })
      await old.addInitScript(strip, alsoClone)
      await old.goto(PAGE_URL)
      const stripped = await old.evaluate((c) => typeof Promise.withResolvers === 'undefined' && typeof Map.prototype.getOrInsertComputed === 'undefined' && typeof URL.parse === 'undefined' && (typeof structuredClone === 'undefined') === c, alsoClone)
      await old.evaluate((u) => window.__fol.openUrl(u, 'tsformat.pdf'), bookAt('tsformat.pdf'))
      let answer = null
      for (const t0 = Date.now(); !answer && Date.now() - t0 < TIMEOUT_MS; await old.waitForTimeout(50)) answer = got.find((x) => x.type === 'opened' || x.type === 'open-failed')
      if (!alsoClone) {
        let drawn = false
        for (const t0 = Date.now(); answer?.type === 'opened' && !drawn && Date.now() - t0 < TIMEOUT_MS; await old.waitForTimeout(100))
          for (const f of old.frames().filter((f) => f.url().startsWith('blob:'))) drawn ||= await f.evaluate(() => !!document.querySelector('.textLayer')?.textContent.includes('Page 1. Sphinx')).catch(() => false)
        check(stripped && answer?.type === 'opened' && drawn, `without the polyfilled APIs a PDF still opens and draws (${answer?.type ?? 'no answer'}${answer?.error ? `, ${answer.error}` : ''})`)
      } else {
        check(stripped && answer?.type === 'open-failed' && /too old to read PDF/.test(answer.error), `without structuredClone a PDF is refused with a clear message (${answer?.type ?? 'no answer'}: ${answer?.error})`)
      }
      await old.close()
    }
  }

  /**
   * #1128 S5 QA: the open order (the book made before the open one is torn down) and PDF edges, on a page
   * of its own. `known(reproduces, what)` is a bug this check documents and does not fix: it passes while the
   * bug reproduces, and fails once it is fixed, so the line is turned into a `check` then.
   */
  async function checkOpenOrder() {
    console.log('open order (S5 QA)')
    const known = (reproduces, what) => { console.log(`  ${reproduces ? 'bug ' : 'FIXED'}  ${what}`); if (!reproduces) failures.push(`known bug no longer reproduces, make it a check: ${what}`) }
    const qa = await newPage()
    const msgs = []
    const pageErrors = []
    qa.on('pageerror', (e) => pageErrors.push(e.message))
    await qa.exposeFunction('__toHost', (json) => msgs.push(JSON.parse(json)))
    await qa.addInitScript(() => { if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) } })
    await qa.goto(PAGE_URL)
    const run = (js) => qa.evaluate(js)
    const until = async (from, match, what) => {
      for (const t0 = Date.now(); Date.now() - t0 < TIMEOUT_MS; await qa.waitForTimeout(50)) { const m = msgs.slice(from).find(match); if (m) return m }
      throw new Error(`timed out waiting for ${what}`)
    }
    const send = (file) => run(`window.__fol.openUrl(${JSON.stringify(bookAt(file))}, ${JSON.stringify(file)})`)
    const openQa = async (file, stored = null) => {
      const from = msgs.length
      await send(file)
      const m = await until(from, (x) => (x.type === 'opened' || x.type === 'open-failed') && (x.book?.name ?? x.name) === file, `${file} to open`)
      if (m.type === 'opened') {
        await run(`window.__fol.restore(${JSON.stringify(stored)})`)
        m.restored = await until(from, (x) => x.type === 'restored', `${file} restored`)
      }
      return { ...m, from }
    }
    const settle = () => qa.waitForTimeout(1200)
    const storesQa = (from) => msgs.slice(from).filter((x) => x.type === 'store')
    const views = () => run('document.querySelectorAll("foliate-view").length')
    const flag = (js) => (async () => { for (const t0 = Date.now(); !(await run(js)) && Date.now() - t0 < TIMEOUT_MS;) await qa.waitForTimeout(20) })()
    await until(0, (x) => x.type === 'ready', 'ready (open order)')
    await openQa('tsformat.pdf')
    // The PDF reader, spied: `__holdNext` holds the next makePDF until `__release()` / `__reject(e)`; `__destroyed` counts book.destroy().
    await run(`(() => {
      const f = window.__tsFormats.pdf, make = f.makePDF
      window.__destroyed = 0
      f.makePDF = async (...a) => {
        if (window.__holdNext) {
          window.__holdNext = false
          await new Promise((ok, no) => { window.__release = ok; window.__reject = no; window.__held = true })
        }
        const b = await make(...a), destroy = b.destroy
        b.destroy = () => { window.__destroyed++; return destroy() }
        return b
      }
    })()`)
    const password = `Object.assign(new Error('No password given'), { name: 'PasswordException' })`

    // One page per screen (spread 'none'): in a landscape view foliate would pair pages 2-3, and `next`
    // from page 1 then page 2 would save page 4. Each turn saves the page it shows.
    await qa.setViewportSize({ width: 1280, height: 720 })
    let m = await openQa('tsformat.pdf')
    const fmt = m.book
    // I6: the label is refused where `annotatable` is false (the call answers false, nothing is drawn).
    const label = `window.__fol.showTranslation('epubcfi(/6/2!/4/2/1:0)', 0, 'x')`
    check(await run(label) === false, 'showTranslation is refused on a PDF')
    let from = msgs.length
    for (const _ of [1, 2]) { run('window.__fol.next()'); await qa.waitForTimeout(500) }
    await settle()
    check(storesQa(from).map((s) => JSON.parse(s.json).position?.page).join() === '2,3', `landscape: next, next saves pages 2 then 3, never a spread (${storesQa(from).map((s) => JSON.parse(s.json).position?.page)})`)
    // I2 on a PDF: a resize (re-layout) and a tap save nothing.
    m = await openQa('tsformat.pdf', JSON.stringify({ v: 1, book: fmt, highlights: [], position: { page: 3, index: 2, fraction: 0.5, at: 1 } }))
    await settle()
    from = msgs.length
    await qa.setViewportSize({ width: 420, height: 760 })
    await settle()
    const cdp = await qa.context().newCDPSession(qa)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 380 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await settle()
    check(m.restored.position === 'restored' && storesQa(from).length === 0, `a restored PDF, resized and tapped, saves nothing (${m.restored.position}, ${JSON.stringify(storesQa(from).map((s) => JSON.parse(s.json).position))})`)

    // A PDF replaced by the next book is destroyed at the swap (view.close() does not; before the S5 fix round each
    // left PDF kept its pdf.js document: +21 MB backing store per 20 MB PDF).
    await run('window.__destroyed = 0')
    await openQa('tsformat.fb2')
    check(await run('window.__destroyed') === 1, `a PDF replaced by the next book is destroyed once (${await run('window.__destroyed')})`)
    // A PDF load that fails (a password) destroys its pdf.js loading task: the page takes it from getDocument.
    await run(`(() => {
      const lib = globalThis.pdfjsLib, get = lib.getDocument
      window.__tasksDestroyed = 0
      lib.getDocument = (p) => { const t = get.call(lib, p), d = t.destroy.bind(t); t.destroy = () => { window.__tasksDestroyed++; return d() }; return t }
    })()`)
    m = await openQa('tslocked.pdf')
    check(m.type === 'open-failed' && await run('window.__tasksDestroyed') === 1, `a PDF that fails to load destroys its loading task (${m.type}, ${await run('window.__tasksDestroyed')})`)

    // I4: a pending save of A (debounced 400 ms) survives B's failed open, under A's key.
    let a = await openQa('tsformat.fb2')
    await settle()
    from = msgs.length
    await run('window.__fol.next(); 0')
    await until(from, (x) => x.type === 'relocate', 'a relocate on A')
    await send('tslocked.pdf')
    await until(from, (x) => x.type === 'open-failed', 'B (password) failed')
    await settle()
    check(storesQa(from).length === 1 && storesQa(from)[0].key === a.book.sha256, `A's pending save lands under A's key after B failed (${storesQa(from).map((s) => s.key === a.book.sha256)})`)
    // …and when B opens within the 400 ms, A's last turn is flushed under A's key at the swap, never under B's.
    a = await openQa('tsformat.fb2')
    await settle()
    from = msgs.length
    await run('window.__fol.next(); 0')
    await until(from, (x) => x.type === 'relocate', 'a relocate on A')
    await send('tsformat.epub')
    await until(from, (x) => x.type === 'opened', 'B opened')
    await settle()
    const flushed = storesQa(from)
    check(flushed.length === 1 && flushed[0].key === a.book.sha256 && JSON.parse(flushed[0].json).book.sha256 === a.book.sha256,
      `A's turn made under 400 ms before B opens is flushed under A's key at the swap, once, never under B's (${flushed.map((s) => s.key === a.book.sha256)})`)

    // I3: A turned while B is being made, B then fails: A is the book on screen throughout (its listener reads
    // viewSeq), so the turn is reported and saved under A's key, and A keeps saving after B failed.
    a = await openQa('tsformat.fb2')
    await settle()
    await run('window.__holdNext = true; window.__held = false')
    from = msgs.length
    await send('tsformat.pdf')
    await flag('window.__held')
    await run('window.__fol.next(); 0')
    await settle()
    // A taken offer on A meanwhile runs on A's own chain and saves under A's key.
    const during = msgs.length
    await run('window.__fol.goTo({ fraction: 0.5, at: 1 }, true); 0')
    await settle()
    check(storesQa(during).length === 1 && storesQa(during)[0].key === a.book.sha256, `a chosen goTo on A while B is made saves under A's key (${storesQa(during).length})`)
    const shownPlace = await run(`document.querySelector('foliate-view').lastLocation?.cfi`)
    await run(`window.__fol.next(); 0`)
    await settle()
    await run(`window.__reject(${password}); 0`)
    await until(from, (x) => x.type === 'open-failed' && x.name === 'tsformat.pdf', 'B failed late in its make')
    await settle()
    const shown = await run(`document.querySelector('foliate-view').lastLocation?.cfi`)
    check(shown !== shownPlace, 'A turned while B was made')
    check(storesQa(from).some((s) => s.key === a.book.sha256 && JSON.parse(s.json).position?.cfi === shown) && msgs.slice(during).some((x) => x.type === 'relocate'),
      'a turn on A while B is made is reported (relocate) and saved under A\'s key')
    from = msgs.length
    await run('window.__fol.next(); 0')
    const later = await until(from, (x) => x.type === 'store', 'a store on A after B failed').catch(() => null)
    check(later?.key === a.book.sha256, 'after B failed, A turns and saves under its own key')

    // B made slowly, C fails fast, D opens; B, released, is not the latest attempt and never swaps in over D (the
    // open seq only goes up: before the S5 fix round C handed it back and D reused B's).
    await openQa('tsformat.fb2')
    await run('window.__holdNext = true; window.__held = false')
    from = msgs.length
    await send('tsformat.pdf')
    await flag('window.__held')
    await send('tslocked.pdf')
    await until(from, (x) => x.type === 'open-failed' && x.name === 'tslocked.pdf', 'C failed')
    await send('tsformat.epub')
    await until(from, (x) => x.type === 'opened' && x.book.name === 'tsformat.epub', 'D opened')
    await run('window.__release(); 0')
    await settle()
    const answered = msgs.slice(from).filter((x) => x.type === 'opened').map((x) => x.book.name)
    check(answered.join() === 'tsformat.epub' && await run(`document.querySelector('foliate-view').book.sections.length`) !== 5 && await views() === 1,
      `a superseded open never opens over the newest book, after a failed open in between (${answered})`)

    // While B is made, A is the book on screen: its restore is answered (S5 fix round).
    await openQa('tsformat.fb2')
    await run('window.__holdNext = true; window.__held = false')
    from = msgs.length
    await send('tsformat.pdf')
    await flag('window.__held')
    await run('window.__fol.restore(null); 0')
    const answeredA = await until(from, (x) => x.type === 'restored', 'A restored while B is made').catch(() => null)
    check(answeredA?.position === 'none', `a restore for A while B is made is answered (${JSON.stringify(answeredA)})`)
    await run('window.__release(); 0')
    await until(from, (x) => x.type === 'opened' && x.book.name === 'tsformat.pdf', 'B opened after A restored')

    // Superseded while made: destroyed, never opened; one view.
    await openQa('tsformat.fb2')
    await run('window.__holdNext = true; window.__held = false; window.__destroyed = 0')
    from = msgs.length
    await send('tsformat.pdf')
    await flag('window.__held')
    await send('tsformat.epub')
    await until(from, (x) => x.type === 'opened', 'C opened')
    await run('window.__release(); 0')
    await settle()
    check(msgs.slice(from).filter((x) => x.type === 'opened').map((x) => x.book.name).join() === 'tsformat.epub' && await run('window.__destroyed') === 1 && await views() === 1,
      'a PDF superseded while it is made is destroyed and never opened; one view')

    // S5 review: B is swapped in and still in view.open when C is asked for and fails before its own swap: B
    // is the book on screen, so it answers `opened` once its open completes, takes its restore and saves.
    await openQa('tsformat.fb2')
    await run(`(() => {
      const C = customElements.get('foliate-view'), open = C.prototype.open
      const held = new Promise((ok) => { window.__releaseOpen = ok })
      C.prototype.open = async function (b) { C.prototype.open = open; window.__inOpen = true; await held; return open.call(this, b) }
    })()`)
    from = msgs.length
    await run('window.__inOpen = false; 0')
    await send('tsformat.epub')
    await flag('window.__inOpen')
    await send('tslocked.pdf')
    await until(from, (x) => x.type === 'open-failed' && x.name === 'tslocked.pdf', 'C failed while B opens')
    await run('window.__releaseOpen(); 0')
    const bOpened = await until(from, (x) => x.type === 'opened' && x.book.name === 'tsformat.epub', 'B answers opened').catch(() => null)
    check(!!bOpened, 'a book swapped in while a newer open fails before its swap answers `opened`')
    if (bOpened) {
      const at = msgs.length
      await run('window.__fol.restore(null); 0')
      const r = await until(at, (x) => x.type === 'restored', 'B restored').catch(() => null)
      await run('window.__fol.next(); 0')
      const st = await until(at, (x) => x.type === 'store', 'B saves').catch(() => null)
      check(r?.key === bOpened.book.sha256 && st?.key === bOpened.book.sha256, `and takes its restore and saves (${r?.position}, ${!!st})`)
    }

    // A failure after the teardown (view.open throws): `open-failed`, nothing saved for either book, the next open works.
    a = await openQa('tsformat.fb2')
    await run(`(() => { const C = customElements.get('foliate-view'), o = C.prototype.open; C.prototype.open = async function () { C.prototype.open = o; throw new Error('late failure') } })()`)
    from = msgs.length
    m = await openQa('tsformat.epub')
    await run('window.__fol.next(); window.__fol.restore(null); 0')
    await settle()
    check(m.type === 'open-failed' && storesQa(from).length === 0 && !msgs.slice(from).some((x) => x.type === 'restored'), `a late failure answers open-failed, saves and restores nothing (${m.type})`)
    check((await openQa('tsformat.fb2')).restored?.position === 'none', 'and the next open works')

    // Shapes pdf.js survives or refuses before the teardown (the book on screen keeps reading).
    const src = pdf(5).toString('latin1')
    const shapes = {
      'tsjunk.pdf': [Buffer.concat([Buffer.alloc(900, 0x41), pdf(2)]), 'opened'],
      'tsxref.pdf': [Buffer.from(src.replace(/startxref\n\d+/, 'startxref\n99999'), 'latin1'), 'opened'],
      'tscount.pdf': [Buffer.from(pdf(1).toString('latin1').replace('/Count 1', '/Count 2147483647'), 'latin1'), 'opened'],
      'tshalf.pdf': [pdf(5).subarray(0, pdf(5).length >> 1), 'open-failed'],
      'tsnoise.pdf': [Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4000, 0x07)]), 'open-failed'],
    }
    for (const [file, [bytes, expected]] of Object.entries(shapes)) {
      writeFileSync(resolve(dir, file), bytes)
      a = await openQa('tsformat.fb2')
      m = await openQa(file)
      const ok = m.type === expected && (expected === 'opened' ? m.sections >= 1 : true)
      from = msgs.length
      if (m.type === 'open-failed') run('window.__fol.next()')
      const st = m.type === 'open-failed' ? await until(from, (x) => x.type === 'store', 'A saves after a refused PDF').catch(() => null) : null
      check(ok && (m.type === 'opened' || st?.key === a.book.sha256), `${file}: ${m.type} (${m.sections ?? m.error})${st ? ', the book on screen still saves' : ''}`)
    }
    writeFileSync(resolve(dir, 'tszero.pdf'), Buffer.from(pdf(1).toString('latin1').replace('/Count 1', '/Count 0').replace(/\/Kids \[[^\]]*\]/, '/Kids []'), 'latin1'))
    m = await openQa('tszero.pdf')
    from = msgs.length
    run('window.__fol.next()')
    const afterZero = await until(from, (x) => x.type === 'store', 'the book on screen saves after a zero-page PDF').catch(() => null)
    check(m.type === 'open-failed' && /this PDF has no pages/.test(m.error) && afterZero?.key === a.book.sha256,
      `a PDF with no page is refused before the swap; the book on screen still saves (${m.type}, ${m.error ?? m.sections})`)

    // A Named action (Print, NextPage…), like ResetForm and an attachment link, throws in pdf.js's annotation
    // layer (foliate's linkService has no getAnchorUrl): the page's whole annotation layer is lost, uncaught.
    const named = pdf(1, { title: 'TS NAMED', annots: [[
      '<< /Type /Annot /Subtype /Link /Rect [40 700 560 720] /Border [0 0 0] /A << /S /Named /N /NextPage >> >>',
      '<< /Type /Annot /Subtype /Link /Rect [40 660 560 680] /Border [0 0 0] /A << /S /URI /URI (https://example.com/) >> >>',
    ]] })
    writeFileSync(resolve(dir, 'tsnamed.pdf'), named)
    check(pageErrors.length === 0, `no page error before the Named-action PDF (${pageErrors.join('; ')})`)
    pageErrors.length = 0
    m = await openQa('tsnamed.pdf')
    await settle()
    let links = 0
    for (const f of qa.frames().filter((f) => f.url().startsWith('blob:'))) links += await f.evaluate(() => document.querySelectorAll('.annotationLayer section').length).catch(() => 0)
    known(m.type === 'opened' && links === 0 && pageErrors.some((e) => /getAnchorUrl/.test(e)), `a Named-action link drops every link of its page with an uncaught error (${links} links; ${pageErrors.join('; ').slice(0, 80)})`)
    // Let through: the known Named-action bug, and `next` on the dead view a late failure leaves (no renderer).
    const expectedError = (msg) => /^open: /.test(msg) || /getAnchorUrl/.test(msg) || /^navigation: TypeError: Cannot read properties of undefined \(reading 'next'\)/.test(msg)
    for (const x of msgs) if (x.type === 'log' && x.level === 'error' && !expectedError(x.msg)) check(false, `page error (open order): ${x.msg.split('\n')[0]}`)
    await qa.close()
    check(true, 'open order done')
  }

  await waitFor(0, (m) => m.type === 'ready', 'ready')
  check(await loaded() === '', 'no format reader has run before a book opens')

  console.log('epub')
  let m = await open('tsformat.epub')
  check(m.type === 'opened' && m.format === 'epub' && m.textual === true && m.annotatable === true && m.title === 'TS EPUB', `opened as epub, textual, annotatable (${m.format}, ${m.title})`)
  check(await loaded() === '', 'an EPUB runs no format reader')
  call('window.__fol.flow("scrolled")')
  check(await call('document.querySelector("foliate-view").renderer.getAttribute("flow")') === 'scrolled', 'flow("scrolled") switches the live renderer')
  check(!messages.slice(m.from).some((x) => x.type === 'ready'), 'the switch did not reload the page')
  const warns = messages.length
  call('window.__fol.flow("sideways")')
  await waitFor(warns, (x) => x.type === 'log' && /flow ignored/.test(x.msg), 'flow ignored')
  check(true, 'an unknown flow is ignored with a warn')
  await checkSelection('epub, scrolled')

  console.log('mobi')
  m = await open('tsformat.mobi')
  const tel = messages.slice(m.from).find((x) => x.type === 'telemetry')
  check(tel?.event === 'reader-flow' && tel.format === 'epub' && tel.mode === 'scrolled' && tel.switchedInFirst5Min === true,
    `the next open ends the EPUB's telemetry session: ${JSON.stringify(tel)}`)
  check(m.type === 'opened' && m.format === 'mobi' && m.textual && m.title === 'TS MOBI' && m.sections === 2, `opened as mobi, 2 sections (${m.format}, ${m.title}, ${m.sections}${m.error ? `, ${m.error}` : ''})`)
  check(await loaded() === 'mobi', 'the MOBI reader ran on the first MOBI, and only it')
  check(await showsText(), 'its text is rendered')
  call('window.__fol.flow("paginated")')
  await checkSelection('mobi, paginated')
  await checkSelectionPaged('mobi, paginated', 'tsformat.fb2')

  for (const file of ['tsformat.fb2', 'tsformat.fbz']) {
    console.log(file.split('.')[1])
    m = await open(file)
    check(m.type === 'opened' && m.format === 'fb2' && m.textual && m.title === 'TS FB2' && m.author === 'Test Author', `${file} opened as fb2 (${m.format}, ${m.title}, ${m.author}${m.error ? `, ${m.error}` : ''})`)
    check(await showsText(), 'its text is rendered')
  }
  check(await loaded() === 'fb2,mobi', 'the FB2 reader ran once, for FB2 and FBZ')
  const tel2 = messages.filter((x) => x.type === 'telemetry').at(-1)
  check(tel2?.format === 'fb2' && tel2.mode === 'paginated' && tel2.switchedInFirst5Min === false, `an unswitched session reports false: ${JSON.stringify(tel2)}`)

  console.log('cbz')
  m = await open('tsformat.cbz')
  check(m.type === 'opened' && m.format === 'cbz' && m.textual === false && m.annotatable === false && m.sections === 2, `opened as cbz, not textual nor annotatable, 2 pages (${m.format}, ${m.textual}, ${m.sections}${m.error ? `, ${m.error}` : ''})`)
  check(await loaded() === 'cbz,fb2,mobi', 'the CBZ reader ran on the first CBZ')
  check(await shown(() => document.querySelector('img')?.naturalWidth === 60), 'its first page image is rendered')
  let from = messages.length
  call('window.__fol.highlightSelection()')
  await waitFor(from, (x) => x.type === 'log' && /has no text/.test(x.msg), 'highlight refused')
  check(true, 'highlightSelection is refused on an image-only book')
  from = messages.length
  call('window.__fol.next()')
  const stored = await waitFor(from, (x) => x.type === 'store', 'a store after the page turn')
  const position = JSON.parse(stored.json).position
  check(position?.page === 'p02.png' && !('quote' in position) && position.cfi.startsWith('epubcfi('), `the page turn saved page 2 by its entry name, no quote (${JSON.stringify(position)})`)
  check(m.reflowable === false, 'opened.reflowable is false for a CBZ (hosts disable the flow toggle)')
  // flow() on a fixed layout changes nothing, so it is no switch.
  call('window.__fol.flow("scrolled")')
  m = await open('tsformat.cbz', stored.json)
  const cbzTel = messages.slice(m.from).find((x) => x.type === 'telemetry')
  check(cbzTel?.format === 'cbz' && cbzTel.switchedInFirst5Min === false, `a flow() on a CBZ is not reported as a switch: ${JSON.stringify(cbzTel)}`)
  call('window.__fol.flow("paginated")')
  check(m.restored.position === 'restored', `reopened, the saved page is restored (${m.restored.position})`)
  const at = await waitFor(m.from, (x) => x.type === 'relocate' && x.index === 1, 'relocate to page 2').catch(() => null)
  check(!!at, 'and the view shows page 2')

  // Positions of the other shape: neither is applied (store.mjs keeps both shapes; restore tells them apart).
  const cbzBook = m.book
  m = await open('tsformat.cbz', JSON.stringify({ v: 1, book: cbzBook, highlights: [], position: { cfi: 'epubcfi(/6/4)', quote: 'Paragraph', index: 1, fraction: 1, at: 1 } }))
  check(m.restored.position === 'page not found, stayed at start', `a quoted position on a CBZ is not applied (${m.restored.position})`)
  m = await open('tsformat.fb2')
  // A CFI that does point at text (the book's own first relocate), so only the missing quote can refuse it.
  const textCfi = (await waitFor(m.from, (x) => x.type === 'relocate' && x.cfi, 'a relocate with a CFI')).cfi
  m = await open('tsformat.fb2', JSON.stringify({ v: 1, book: m.book, highlights: [], position: { cfi: textCfi, page: 'p02.png', index: 0, fraction: 0, at: 1 } }))
  check(m.restored.position === 'quote mismatch, stayed at start', `a page position on a textual book is not applied (${m.restored.position})`)

  // A fraction-only position (a transitional server locator, #1187): restored by fraction, and nothing
  // saved until the reader moves (the server's locator is not rewritten by opening the book).
  console.log('fraction')
  const fb2Book = m.book
  const byFraction = (position) => JSON.stringify({ v: 1, book: fb2Book, highlights: [], position })
  const settle = () => page.waitForTimeout(1200)
  const lastRelocate = (from) => messages.slice(from).filter((x) => x.type === 'relocate').at(-1)
  const storeFrom = (from, what) => waitFor(from, (x) => x.type === 'store', what).then((s) => JSON.parse(s.json)).catch(() => null)
  const storesFrom = (from) => messages.slice(from).filter((x) => x.type === 'store').map((x) => JSON.parse(x.json).position)
  /** The entry as the page holds it: a highlight on the shown page saves it whole. */
  const heldEntry = async () => {
    // A paragraph on screen: a highlight is of the selection sent (#1268), and one off screen is never sent.
    await call(`(() => {
      const c = document.querySelector('foliate-view').renderer.getContents()[0], fr = c.doc.defaultView.frameElement.getBoundingClientRect()
      const p = [...c.doc.querySelectorAll('p')].find((p) => { const r = p.getBoundingClientRect(); return fr.left + r.left >= 0 && fr.left + r.right <= innerWidth && fr.top + r.top >= 0 && fr.top + r.bottom <= innerHeight })
      c.doc.getSelection().selectAllChildren(p)
    })()`)
    // After the settle time, as a host's button can only be.
    await page.waitForTimeout(600)
    const from = messages.length
    call('window.__fol.highlightSelection()')
    return storeFrom(from, 'a store after a highlight')
  }
  m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
  check(m.restored.position === 'restored by fraction', `a fraction-only position is restored (${m.restored.position})`)
  const far = await waitFor(m.from, (x) => x.type === 'relocate' && x.index === 1 && x.fraction > 0.5, 'relocate near the end').catch(() => null)
  check(!!far, `and the view is past the start (${JSON.stringify(messages.filter((x) => x.type === 'relocate').at(-1))})`)
  // foliate relocates at the landed place again after `restored`: those relocates must not save either.
  await page.waitForTimeout(1500)
  check(!messages.slice(m.from).some((x) => x.type === 'store'), 'restoring by fraction saves nothing')
  // A host goTo (not chosen: a sync adopt or move) saves nothing, and the page takes its position as its own.
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.05, at: 2 })')
  await settle()
  check(storesFrom(from).length === 0, `a host fraction goTo saves nothing (${JSON.stringify(storesFrom(from))})`)
  const quietPos = (await heldEntry())?.position
  check(quietPos?.fraction === 0.05 && !('cfi' in quietPos), `and the page holds its fraction-only position, no CFI (${JSON.stringify(quietPos)})`)
  from = messages.length
  call('window.__fol.next()')
  const moved = await waitFor(from, (x) => x.type === 'store', 'a store after the reader moves').catch(() => null)
  check(JSON.parse(moved?.json ?? '{}').position?.cfi?.startsWith('epubcfi('), 'the reader moving saves a CFI position')
  m = await open('tsformat.fb2', byFraction({ fraction: 2, at: 1 }))
  check(m.restored.rejected === false && m.restored.position === 'none', `a fraction outside [0, 1] is not applied (${m.restored.position})`)
  from = messages.length
  call('window.__fol.next()')
  check(!!(await waitFor(from, (x) => x.type === 'store', 'a store after a refused fraction').catch(() => null)), 'and the book still turns and saves')

  // After a fraction landing (#1187 QA): the save rule holds the landing, and nothing more.
  console.log('fraction hold')
  for (const fraction of [0, 1]) {
    m = await open('tsformat.fb2', byFraction({ fraction, at: 1 }))
    await settle()
    check(m.restored.position === 'restored by fraction' && (fraction ? lastRelocate(m.from)?.fraction === 1 : lastRelocate(m.from)?.index === 0 && lastRelocate(m.from).fraction < 0.5) && !messages.slice(m.from).some((x) => x.type === 'store'),
      `fraction ${fraction} is restored at that end and saves nothing (${m.restored.position}, ${lastRelocate(m.from)?.fraction})`)
  }
  m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
  await settle()
  const held = lastRelocate(m.from).cfi
  // A refused open, or one that fails before the teardown (a PDF that needs a password, #1128 S5), leaves
  // the held book as it was: it still turns and saves.
  check((await open('tsplain.txt')).type === 'open-failed', 'a non-book picked over a fraction landing is refused')
  check((await open('tslocked.pdf')).type === 'open-failed', 'a password-protected PDF picked over a fraction landing fails')
  from = messages.length
  call('window.__fol.next()')
  const afterRefusal = await storeFrom(from, 'a store after a refusal over a fraction landing')
  check(afterRefusal?.position?.cfi?.startsWith('epubcfi('), 'and the held book still turns and saves a CFI')
  // I5: once moved, coming back to the very place the fraction landed on is a move like any other.
  from = messages.length
  call('window.__fol.prev()')
  const back = await storeFrom(from, 'a store after moving back to the landing')
  check(back?.position?.cfi === held, `moving back onto the landed CFI saves it (${back?.position?.cfi} vs ${held})`)
  // A host CFI goTo (round 3): saves nothing; the next real page turn saves a CFI from the new place.
  // Chosen (a taken offer), the same CFI goTo saves where it landed.
  m = await open('tsformat.fb2')
  await settle()
  from = messages.length
  call(`window.__fol.goTo(${JSON.stringify(held)})`)
  await settle()
  check(storesFrom(from).length === 0 && lastRelocate(from)?.index === 1, `a host CFI goTo moves the view and saves nothing (${JSON.stringify(storesFrom(from))})`)
  from = messages.length
  call('window.__fol.prev()')
  const fromThere = await storeFrom(from, 'a store after a page turn following a host CFI goTo')
  check(fromThere?.position?.cfi?.startsWith('epubcfi(/6/4') && fromThere.position.index === 1, `and the next page turn saves a CFI from the new place (${fromThere?.position?.cfi})`)
  m = await open('tsformat.fb2')
  await settle()
  from = messages.length
  call(`window.__fol.goTo(${JSON.stringify(held)}, true)`)
  const reopened = await storeFrom(from, 'a store after a chosen CFI goTo in a reopened book')
  check(reopened?.position?.cfi === held, `a chosen CFI goTo saves the place it landed on (${reopened?.position?.cfi})`)
  // A host fraction goTo saves nothing, now or after foliate's relocates at the landing.
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.5, at: 3 })')
  await settle()
  check(storesFrom(from).length === 0, `a host fraction goTo saves nothing, then nothing (${storesFrom(from).length} stores)`)
  // The same right after `restored` (a host's sync adopt at open): the opening layout still relocates,
  // at the landing, after the goTo has settled; none of that may save, and the page holds the fraction.
  m = await open('tsformat.fb2')
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.9, at: 6 })')
  await settle()
  check(storesFrom(from).length === 0, `a host fraction goTo right after restored saves nothing (${JSON.stringify(storesFrom(from))})`)
  const early = (await heldEntry())?.position
  check(early?.fraction === 0.9 && !('cfi' in early), `and the page holds the fraction (${JSON.stringify(early)})`)

  // Highlights on an entry whose position is fraction-only: drawn, and kept by every later save.
  const hl = await call(`(() => {
    const v = document.querySelector('foliate-view')
    const c = v.renderer.getContents().find((x) => x.doc.querySelector('p'))
    const t = c.doc.querySelector('p').firstChild, i = t.data.indexOf('Sphinx')
    const r = c.doc.createRange(); r.setStart(t, i); r.setEnd(t, i + 6)
    return { id: '11111111-1111-4111-8111-111111111111', cfi: v.getCFI(c.index, r), index: c.index, quote: 'Sphinx', selectedText: 'Sphinx', prefix: '', suffix: '', color: 'yellow', at: 1 }
  })()`)
  m = await open('tsformat.fb2', JSON.stringify({ v: 1, book: fb2Book, highlights: [hl], position: { fraction: 0.9, at: 1 } }))
  check(m.restored.position === 'restored by fraction' && m.restored.highlights[0]?.status === 'restored', `a fraction-only entry's highlight is restored (${JSON.stringify(m.restored.highlights)})`)
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.2, at: 4 })')
  await settle()
  check(storesFrom(from).length === 0, 'a host fraction goTo on an entry with a highlight saves nothing')
  from = messages.length
  call('window.__fol.next()')
  const movedHl = await storeFrom(from, 'a store after a move with a highlight')
  check(movedHl?.highlights?.[0]?.id === hl.id && movedHl.position.cfi?.startsWith('epubcfi('), 'and so does the first real move')

  // A fixed-layout book (CBZ) lands a fraction on its page, quietly too, and saves its page once moved.
  m = await open('tsformat.cbz', JSON.stringify({ v: 1, book: cbzBook, highlights: [], position: { fraction: 0.9, at: 1 } }))
  await settle()
  check(m.restored.position === 'restored by fraction' && lastRelocate(m.from)?.index === 1 && !messages.slice(m.from).some((x) => x.type === 'store'),
    `a CBZ fraction lands on its page, saving nothing (${m.restored.position}, page ${lastRelocate(m.from)?.index})`)
  from = messages.length
  call('window.__fol.prev()')
  const cbzMoved = await storeFrom(from, 'a store after a CBZ page turn')
  check(cbzMoved?.position?.page === 'p01.png', `and its page turn saves the page (${JSON.stringify(cbzMoved?.position)})`)

  console.log('more shapes')
  m = await open('tsupper.cbz')
  check(m.type === 'open-failed' ? false : m.format === 'cbz' && m.sections === 2, `a CBZ with upper-case extensions keeps every page (${m.sections ?? m.error})`)
  check(await shown(() => document.querySelector('img')?.naturalWidth === 60), 'its first page image is rendered')
  call('window.__fol.next()')
  check(await shown(async () => {
    const img = document.querySelector('img')
    return img?.naturalWidth === 60 && (await (await fetch(img.src)).blob()).type === 'image/svg+xml'
  }), 'its SVG page is rendered as an image (typed image/svg+xml)')
  m = await open('tsutf16.fb2')
  check(m.type === 'opened' && m.format === 'fb2' && m.title === 'TS FB2', `a UTF-16 FB2 opens (${m.title ?? m.error})`)
  check(await showsText(), 'its text is rendered')
  m = await open('tscombo.mobi')
  check(m.type === 'opened' && m.format === 'mobi' && m.title === 'TS COMBO', `a combo whose KF8 boundary holds no MOBI header opens as its MOBI6 half (${m.title ?? m.error})`)
  check(await showsText(), 'its text is rendered')

  // KF8 (#1182), on the SYNTHETIC Calibre-made books in synthetic/ (kf8fixture.mjs): says nothing about
  // real-world Kindle files.
  console.log('kf8 (synthetic)')
  m = await open('tssynthetic-kf8.azw3')
  check(m.type === 'opened' && m.format === 'mobi' && m.textual && m.title === 'TS Synthetic KF8' && m.author === 'TextStack Fixture' && m.sections === 3
    && m.toc.map((t) => t.label).join() === 'Part One,Part Two,Part Three', `an AZW3 opens: 3 sections, its TOC (${m.title ?? m.error}, ${m.sections}, ${m.toc?.map((t) => t.label)})`)
  const kf8Book = m.book
  for (const [i, text] of [[0, 'Kestrel lanterns'], [1, 'Copper gulls'], [2, 'harbour keeps its lamps']]) {
    call(`window.__fol.goTo(${i})`)
    check(await shown(`!!document.body?.innerText.includes(${JSON.stringify(text)})`), `section ${i} renders its own text`)
  }
  call('window.__fol.goTo(0)')
  check(await shown(async () => {
    const [css, png, svg, mark] = [document.querySelector('link[rel=stylesheet]'), document.querySelector('img.plate'), document.querySelector('img.badge'), document.querySelector('p.mark')]
    const type = async (url) => (await (await fetch(url)).blob()).type
    return !!(css && png && svg && mark) && png.naturalWidth === 120 && svg.naturalWidth === 80 && getComputedStyle(mark).color === 'rgb(10, 120, 30)'
      && await type(css.href) === 'text/css' && await type(png.src) === 'image/png' && await type(svg.src) === 'image/svg+xml'
  }), 'its resources are typed (text/css, image/png, image/svg+xml): the CSS applies, the PNG and the SVG render')
  // Section 2 carries a refresh meta to section 1: dropped through the KF8 transformTarget, so its frame stays.
  call('window.__fol.goTo(1)')
  check(await shown(() => document.body?.innerText.includes('Copper gulls') && ![...document.querySelectorAll('meta[http-equiv]')].some((x) => /refresh/i.test(x.getAttribute('http-equiv')))), 'the refresh meta of a KF8 section is stripped')
  await settle()
  check(await shown(() => document.body?.innerText.includes('Copper gulls')), 'and its section still shows after the refresh delay')
  // The internal link (kindle:pos) goes to section 3's harbour paragraph, inside the book: no openLink.
  call('window.__fol.goTo(0)')
  await shown(() => document.body?.innerText.includes('Kestrel lanterns'))
  from = messages.length
  for (const f of page.frames().filter((f) => f.url().startsWith('blob:'))) await f.evaluate(() => document.querySelector('a[href]')?.click()).catch(() => {})
  const linked = await storeFrom(from, 'a store after the internal link')
  check(lastRelocate(from)?.index === 2 && linked?.position?.index === 2 && !messages.slice(from).some((x) => x.type === 'openLink'),
    `the internal link goes to section 3 and saves there, no openLink (${lastRelocate(from)?.index}, ${JSON.stringify(linked?.position)})`)
  m = await open('tssynthetic-kf8.azw3', JSON.stringify(linked))
  await settle()
  check(m.restored.position === 'restored' && lastRelocate(m.from)?.cfi === linked?.position?.cfi, `reopened, its position is restored (${m.restored.position}, ${lastRelocate(m.from)?.cfi} vs ${linked?.position?.cfi})`)
  check(m.book.sha256 === kf8Book.sha256, 'the same book')
  m = await open('tssynthetic-combo.mobi')
  check(m.type === 'opened' && m.sections === 3 && m.toc.map((t) => t.label).join() === 'Part One,Part Two,Part Three', `a MOBI/KF8 combo reads its KF8 half: 3 sections, its TOC (${m.sections ?? m.error})`)
  check(await shown(() => { const p = document.querySelector('p.mark'); return !!p && getComputedStyle(p).color === 'rgb(10, 120, 30)' }), 'with its CSS (the MOBI6 half has none)')

  console.log('refused')
  // A refusal leaves the open book as it was: it keeps relocating and saving (no seq turnover, no session end).
  m = await open('tsformat.epub')
  const alive = messages.length
  // KF8: the synthetic AZW3 with the DRM flag; with its SKEL index pointing at a text record (damaged); a
  // header with no indexes at all (tskf8.mobi). foliate would fail on the last two only after teardown.
  const azw3 = readFileSync(resolve(dir, 'tssynthetic-kf8.azw3'))
  const r0 = azw3.readUInt32BE(78)
  const patched = (write) => { const b = Buffer.from(azw3); write(b); return b }
  writeFileSync(resolve(dir, 'tsdrm.azw3'), patched((b) => b.writeUInt16BE(2, r0 + 12)))
  writeFileSync(resolve(dir, 'tsdamaged.azw3'), patched((b) => b.writeUInt32BE(1, r0 + 252)))
  for (const [file, error] of [['tsdrm.mobi', /DRM/], ['tsdrm.azw3', /DRM/], ['tsdamaged.azw3', /truncated or damaged/], ['tskf8.mobi', /truncated or damaged/], ['tsplain.txt', /not a book this reader opens/], ['tslocked.pdf', /password-protected/]]) {
    const r = await open(file)
    check(r.type === 'open-failed' && error.test(r.error), `${file} is refused: ${r.error}`)
  }
  // Entities, flat or nested: refused before the XML parser sees them (a flat one ×30k hangs the page).
  const lol = ['<!ENTITY l0 "lol">', ...Array.from({ length: 9 }, (_, i) => `<!ENTITY l${i + 1} "${`&l${i};`.repeat(10)}">`)].join('')
  writeFileSync(resolve(dir, 'tsbomb.fb2'), fb2('TS bomb', '<section><p>&l9;</p></section>', `<!DOCTYPE FictionBook [${lol}]>`))
  writeFileSync(resolve(dir, 'tsflat.fb2'), fb2('TS flat', `<section><p>${'&e;'.repeat(30000)}</p></section>`, `<!DOCTYPE FictionBook [<!ENTITY e "${'x'.repeat(800)}">]>`))
  writeFileSync(resolve(dir, 'tsxxe.fb2'), fb2('TS xxe', '<section><p>&x;</p></section>', '<!DOCTYPE FictionBook [<!ENTITY x SYSTEM "file:///etc/passwd">]>'))
  for (const file of ['tsbomb.fb2', 'tsflat.fb2', 'tsxxe.fb2']) {
    const r = await open(file).catch((e) => ({ type: 'hung', error: e.message }))
    check(r.type === 'open-failed' && /custom entities/.test(r.error), `${file} is refused before parsing: ${r.error}`)
  }
  call('window.__fol.next()')
  check(!!(await waitFor(alive, (x) => x.type === 'store', 'a store after the refusals').catch(() => null)), 'the EPUB open before the refusals still turns and saves')
  check(!messages.slice(alive).some((x) => x.type === 'telemetry'), 'and its telemetry session was not ended by them')

  // A re-layout right after a fraction landing — the WebView resized (the host's offer banner or error
  // line appearing above it, rotation), a font or flow change — is not the reader moving: it saves no CFI
  // over the server's transitional locator (I1). The first real move after it does save one (I5).
  // (The resize logs a benign ResizeObserver error: the page-error sweep at the end lets that one through.)
  console.log('re-layout after a fraction landing')
  for (const [what, relayout, restore] of [
    ['a resize', () => page.setViewportSize({ width: 500, height: 400 }), () => page.setViewportSize({ width: 1280, height: 720 })],
    ['a font change', () => call('window.__fol.font(6)'), () => call('window.__fol.font(-6)')],
    ['a flow switch', () => call('window.__fol.flow("scrolled")'), () => call('window.__fol.flow("paginated")')],
  ]) {
    m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
    await settle()
    from = messages.length
    await relayout()
    await settle()
    const relaid = messages.slice(from).filter((x) => x.type === 'relocate').length
    check(relaid > 0 && storesFrom(from).length === 0, `${what} after a fraction landing relocates (${relaid}) but saves nothing (${JSON.stringify(storesFrom(from))})`)
    // Back, not forward: scrolled at 0.9 the section's end can already be on screen, with no next to go to.
    from = messages.length
    call('window.__fol.prev()')
    const turned = await storeFrom(from, `a store after a page turn following ${what}`)
    check(turned?.position?.cfi?.startsWith('epubcfi('), `and the page turn after ${what} saves a CFI`)
    await restore()
    await settle()
  }

  // A goTo still loading its section when another book opens never settles on the closed view; the next
  // book starts a navigation chain of its own, so it still restores, turns and saves (and the stale goTo
  // never moves it). A host goTo (a sync adopt, a taken offer) followed by a book switch.
  console.log('goTo across an open')
  m = await open('tsformat.fb2')
  from = messages.length
  await call(`window.__fol.goTo({ fraction: 0.8, at: 5 }); window.__fol.openUrl(${JSON.stringify(bookAt('tsformat.epub'))}, 'tsformat.epub')`)
  const next = await waitFor(from, (x) => x.type === 'opened', 'the next book opened')
  // Not awaited: on a wedged chain restore never settles, and the check must fail, not hang.
  call(`window.__fol.restore(${JSON.stringify(JSON.stringify({ v: 1, book: next.book, highlights: [], position: { fraction: 0.5, at: 1 } }))})`).catch(() => {})
  const answered = await waitFor(from, (x) => x.type === 'restored', 'restored after a goTo across an open').catch(() => null)
  check(answered?.position === 'restored by fraction', `a goTo in flight across openUrl does not hold up the next book (${answered?.position})`)
  check(!messages.slice(from).some((x) => x.type === 'store' && x.key !== next.book.sha256), 'nothing is saved for the previous book after the switch')
  from = messages.length
  call('window.__fol.next()')
  check(!!(await waitFor(from, (x) => x.type === 'store' && x.key === next.book.sha256, 'a store after the switch').catch(() => null)), 'and the next book turns and saves')

  // The save rule (#1187 round 2): a relocate saves only when it is not a re-layout ('anchor') and its CFI
  // differs from the previous relocate's. A tap ends in foliate's touchend 'snap', a relocate where the
  // view already is: no move, so no save, after a re-layout moved the anchor too.
  console.log('save rule')
  const cdp = await page.context().newCDPSession(page)
  const tap = async () => {
    const at = { x: 640, y: 360 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  const entryOf = (b, position) => JSON.stringify({ v: 1, book: b, highlights: [], position })
  m = await open('tsformat.fb2', byFraction({ fraction: 0.9, at: 1 }))
  await settle()
  await call('window.__fol.font(4)')
  await settle()
  from = messages.length
  await tap()
  await settle()
  check(messages.slice(from).some((x) => x.type === 'relocate') && storesFrom(from).length === 0,
    `a tap after a fraction landing and a font change relocates (snap) but saves nothing (${JSON.stringify(storesFrom(from))})`)
  await call('window.__fol.font(-4)')
  // A CFI restore: opening the book re-stamps nothing; only a real page turn saves.
  const cfiEntry = moved.json
  m = await open('tsformat.fb2', cfiEntry)
  await settle()
  await tap()
  await settle()
  check(m.restored.position === 'restored' && storesFrom(m.from).length === 0, `a CFI restore, settled and tapped, saves nothing (${m.restored.position}, ${JSON.stringify(storesFrom(m.from))})`)
  from = messages.length
  call('window.__fol.next()')
  const turnedCfi = await storeFrom(from, 'a store after a page turn on a CFI restore')
  check(turnedCfi?.position?.cfi?.startsWith('epubcfi('), 'and its first page turn saves a CFI')

  // A taken offer (goTo chosen): the place the fraction landed on is saved as a CFI position, once.
  console.log('taken offer')
  m = await open('tsformat.fb2')
  await settle()
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.6, at: 7 }, true)')
  const taken = await storeFrom(from, 'a store after a taken fraction offer')
  await settle()
  const landedAt = lastRelocate(from)
  check(taken?.position?.cfi === landedAt?.cfi && taken.position.quote && taken.position.index === landedAt.index && storesFrom(from).length === 1,
    `a taken fraction offer saves the landed place as a CFI, once (${JSON.stringify(taken?.position)} vs ${landedAt?.cfi})`)

  // Arrival (#1187 round 2): foliate's goTo resolves with what it resolved, arrived or not. A view that
  // does not get there (here: a goTo that resolves section 1 and stays put) changes nothing and says so.
  console.log('fraction not arrived')
  const stuck = `document.querySelector('foliate-view').goTo = async () => ({ index: 1 })`
  m = await open('tsformat.fb2')
  await settle()
  await call(stuck)
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.9, at: 8 }, true)')
  await waitFor(from, (x) => x.type === 'log' && /did not land/.test(x.msg), 'a not-landed warn')
  await settle()
  check(storesFrom(from).length === 0, 'a taken fraction offer that did not arrive saves nothing')
  from = messages.length
  await call(`window.__fol.openUrl(${JSON.stringify(bookAt('tsformat.fb2'))}, 'tsformat.fb2')`)
  await waitFor(from, (x) => x.type === 'opened', 'opened for a not-arrived restore')
  await call(stuck)
  call(`window.__fol.restore(${JSON.stringify(byFraction({ fraction: 0.9, at: 1 }))})`).catch(() => {})
  const notArrived = await waitFor(from, (x) => x.type === 'restored', 'restored, not arrived')
  await settle()
  check(notArrived.position === 'navigation failed, stayed at start' && storesFrom(from).length === 0,
    `a fraction restore that did not arrive says so and saves nothing (${notArrived.position})`)

  // Fraction 0 (never read on the other device): the text start init showed, not the cover before it.
  console.log('fraction 0')
  m = await open('tscover.epub')
  const coverBook = m.book
  check(lastRelocate(m.from)?.index === 1, `a book with a non-linear cover first opens at its text start (section ${lastRelocate(m.from)?.index})`)
  m = await open('tscover.epub', entryOf(coverBook, { fraction: 0, at: 1 }))
  await settle()
  check(m.restored.position === 'restored by fraction' && lastRelocate(m.from)?.index === 1 && storesFrom(m.from).length === 0,
    `fraction 0 restores at the text start, not the cover, saving nothing (${m.restored.position}, section ${lastRelocate(m.from)?.index})`)
  call('window.__fol.next()')
  await settle()
  from = messages.length
  call('window.__fol.goTo({ fraction: 0, at: 9 })')
  await settle()
  check(lastRelocate(from)?.index === 1 && storesFrom(from).length === 0, `a fraction 0 goTo goes to the text start, saving nothing (section ${lastRelocate(from)?.index})`)

  // The stale-call window: the next book's openUrl has turned the open seq over while its bytes are still
  // hashing, and the previous view still shows. A `next` queued on that view and a `restore` for it, made
  // in the window, never run on or answer for the next book. Deterministic: the previous view's goTo is
  // held, and the next book's file read is released by the check, in the same turn as the two calls.
  // (#1128 S5: the restore is now accepted for the view on screen, and queued behind its held goTo; the
  // swap drops that chain, so it never runs. That an unheld one IS answered: checkOpenOrder.)
  console.log('stale-call window')
  m = await open('tsformat.fb2')
  const previousBook = m.book
  await settle()
  await call(`(() => {
    const v = document.querySelector('foliate-view')
    const held = new Promise((ok) => { window.__releasePrevious = ok })
    v.goTo = () => held.then(() => undefined)
    const send = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = function () {
      XMLHttpRequest.prototype.send = send
      const x = this, load = x.onload
      x.onload = () => { window.__loadNext = () => load.call(x) }
      return send.call(x)
    }
  })()`)
  // Held: the previous view's chain is busy from here on (not awaited: it settles only on release).
  call('window.__fol.section(1)').catch(() => {})
  from = messages.length
  await call(`window.__fol.openUrl(${JSON.stringify(bookAt('tsformat.epub'))}, 'tsformat.epub')`)
  for (const t0 = Date.now(); !(await call('!!window.__loadNext')) && Date.now() - t0 < TIMEOUT_MS;) await page.waitForTimeout(20)
  // Both calls queue on the previous view's (held) chain, which the swap drops.
  await call(`window.__loadNext(); window.__fol.next(); window.__fol.restore(null); window.__fol.restore(${JSON.stringify(entryOf(previousBook, { fraction: 0.9, at: 1 }))}); 0`)
  const nextBook = await waitFor(from, (x) => x.type === 'opened', 'the next book opened after the window')
  const afterOpened = messages.length
  await call('window.__releasePrevious()')
  await settle()
  check(!messages.slice(from).some((x) => x.type === 'restored'), 'a restore made in the window answers nothing')
  check(!messages.slice(afterOpened).some((x) => x.type === 'relocate'), 'a next queued in the window never moves the next book')
  // The next book is still restoring: a turn before its own restore saves nothing.
  from = messages.length
  call('window.__fol.next()')
  await settle()
  check(storesFrom(from).length === 0, 'the next book saves nothing before its own restore (the stale restore did not end it)')
  from = messages.length
  call('window.__fol.restore(null)').catch(() => {})
  const own = await waitFor(from, (x) => x.type === 'restored', 'the next book restored').catch(() => null)
  check(own?.found === false && own.position === 'none', `the next book answers its own restore (${JSON.stringify(own)})`)
  call('window.__fol.next()')
  check(!!(await waitFor(from, (x) => x.type === 'store' && x.key === nextBook.book.sha256, 'a store on the next book').catch(() => null)), 'and then turns and saves')

  // Restore takes its slot in the navigation queue when called (round 3): a host goTo sent while the
  // restore still checks its quotes runs after it and wins: the view ends where the goTo went, and the
  // page holds the goTo's position, not the restored one.
  console.log('restore then goTo')
  m = await open('tsformat.fb2')
  await settle()
  from = messages.length
  call('window.__fol.next()')
  const startEntry = await waitFor(from, (x) => x.type === 'store', 'a store at the start').then((x) => x.json)
  from = messages.length
  await call(`window.__fol.openUrl(${JSON.stringify(bookAt('tsformat.fb2'))}, 'tsformat.fb2')`)
  await waitFor(from, (x) => x.type === 'opened', 'opened for restore then goTo')
  await call(`window.__fol.restore(${JSON.stringify(startEntry)}); window.__fol.goTo({ fraction: 0.9, at: 10 }); 0`)
  const restoredFirst = await waitFor(from, (x) => x.type === 'restored', 'restored before the goTo')
  await settle()
  const ended = lastRelocate(from)
  check(restoredFirst.position === 'restored' && ended?.index === 1 && ended.fraction > 0.5 && storesFrom(from).length === 0,
    `a goTo sent during a restore lands last and nothing is saved (${restoredFirst.position}, section ${ended?.index}, ${ended?.fraction})`)
  const won = (await heldEntry())?.position
  check(won?.fraction === 0.9 && !('cfi' in won), `and the page holds the goTo's position (${JSON.stringify(won)})`)

  // A restore for a view still opening (round 3): the same file opened twice, the host answering the
  // first `opened` while the second open builds its view. Refused, so the second view's text-start
  // relocate is never saved over the stored place. Deterministic: the second view's open is held.
  console.log('restore during an open')
  m = await open('tsformat.fb2')
  await settle()
  const fb2Entry = byFraction({ fraction: 0.9, at: 1 })
  await call(`(() => {
    const C = customElements.get('foliate-view'), open = C.prototype.open
    const held = new Promise((ok) => { window.__releaseOpen = ok })
    C.prototype.open = async function (b) { C.prototype.open = open; window.__inOpen = true; await held; return open.call(this, b) }
  })()`)
  from = messages.length
  await call(`window.__fol.openUrl(${JSON.stringify(bookAt('tsformat.fb2'))}, 'tsformat.fb2')`)
  for (const t0 = Date.now(); !(await call('!!window.__inOpen')) && Date.now() - t0 < TIMEOUT_MS;) await page.waitForTimeout(20)
  await call(`window.__fol.restore(${JSON.stringify(fb2Entry)}); window.__releaseOpen(); 0`)
  await waitFor(from, (x) => x.type === 'opened', 'the second open answered')
  await settle()
  check(!messages.slice(from).some((x) => x.type === 'restored') && storesFrom(from).length === 0,
    `a restore for a view still opening is refused: no answer, nothing saved (${JSON.stringify(storesFrom(from))})`)
  from = messages.length
  call(`window.__fol.restore(${JSON.stringify(fb2Entry)})`).catch(() => {})
  check((await waitFor(from, (x) => x.type === 'restored', 'the second open restored'))?.position === 'restored by fraction', 'and the opened view takes its own restore')

  // A taken offer saves what a relocate would save (round 3, one builder). A pre-paginated EPUB has text
  // but no range from foliate's fixed-layout renderer: nothing to save, and nothing throws.
  console.log('fixed layout')
  m = await open('tsfixed.epub')
  check(m.type === 'opened' && m.reflowable === false && m.textual === true, `a pre-paginated EPUB opens fixed-layout, textual (${m.reflowable}, ${m.textual}${m.error ? `, ${m.error}` : ''})`)
  m = await open('tsfixed.epub', entryOf(m.book, null))
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.9, at: 11 }, true)')
  await waitFor(from, (x) => x.type === 'log' && /nothing to save here/.test(x.msg), 'nothing to save on a pre-paginated EPUB').catch(() => null)
  await settle()
  check(storesFrom(from).length === 0 && messages.slice(from).some((x) => x.type === 'log' && /nothing to save here/.test(x.msg)),
    'a taken offer on a pre-paginated EPUB saves nothing and says so')
  // #1268: the fixed-layout renderer scales a pre-paginated page's frame with a transform; a selection's rect
  // is where the text is drawn. A page turned away clears it. On a spread, a change in one frame does not
  // cancel the other frame's selection.
  console.log('fixed layout selection')
  m = await open('tsfixed.epub', entryOf(m.book, null))
  {
    const f = await frameWith('Page 1. Sphinx')
    const scale = await f?.evaluate(() => frameElement.getBoundingClientRect().width / frameElement.offsetWidth)
    from = messages.length
    await f?.evaluate(() => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      while (w.nextNode() && !w.currentNode.data.includes('black quartz'));
      const r = document.createRange()
      r.setStart(w.currentNode, w.currentNode.data.indexOf('black quartz'))
      r.setEnd(w.currentNode, w.currentNode.data.indexOf('black quartz') + 12)
      const span = document.createElement('span')
      span.id = 'ts-sel'
      r.surroundContents(span)
      getSelection().selectAllChildren(span)
    })
    await settled()
    const real = await (await f?.$('#ts-sel'))?.boundingBox()
    const v = readSelection(messages.slice(from).find((x) => x.type === 'selection'))
    const near = (a, b) => Math.abs(a - b) <= 1
    check(!!real && !!v && Math.abs(scale - 1) > 0.01 && near(v.rect.x, real.x) && near(v.rect.y, real.y) && near(v.rect.w, real.width) && near(v.rect.h, real.height),
      `a selection on a scaled page (scale ${scale?.toFixed(2)}) is placed where it is drawn (${JSON.stringify(v?.rect)} vs ${JSON.stringify(real)})`)
    from = messages.length
    await call('window.__fol.next()')
    check(!!(await waitFor(from, (x) => x.type === 'selection-cleared', 'fixed selection cleared').catch(() => null)), 'a pre-paginated page turned away from the selection clears it')
    const [f2, f3] = [await frameWith('Page 2. Sphinx'), await frameWith('Page 3. Sphinx')]
    check(!!f2 && !!f3 && f2 !== f3, 'pages 2 and 3 are shown side by side')
    if (f2 && f3) {
      await settled()
      from = messages.length
      await select(f2, 'black quartz', 0, 'black quartz', 'black quartz'.length)
      await f3.evaluate(() => { getSelection().selectAllChildren(document.body); getSelection().removeAllRanges() })
      await settled()
      const two = messages.slice(from).filter((x) => x.type === 'selection' || x.type === 'selection-cleared')
      check(two.length === 1 && two[0].type === 'selection' && two[0].text === 'black quartz' && two[0].index === 1,
        `a change in the other frame of a spread does not cancel this frame's selection (${JSON.stringify(two.map((x) => [x.type, x.text, x.index]))})`)
      check(await unselect(f2), 'and it is cleared when collapsed')
    }
  }
  m = await open('tsformat.cbz', entryOf(cbzBook, null))
  from = messages.length
  call('window.__fol.goTo({ fraction: 0.9, at: 12 }, true)')
  const cbzTaken = await storeFrom(from, 'a store after a taken offer on a CBZ')
  check(cbzTaken?.position?.page === 'p02.png' && !('quote' in cbzTaken.position), `a taken offer on a CBZ saves its page, as a page turn does (${JSON.stringify(cbzTaken?.position)})`)
  // Arrival on a fixed layout: a target in the spread already shown emits no relocate, and is arrived.
  m = await open('tsthree.cbz')
  m = await open('tsthree.cbz', entryOf(m.book, null))
  const paired = await call(`(() => { const v = document.querySelector('foliate-view'), r = v.renderer, s = v.book.sections; return r.getSpreadOf(s[1]).index === r.getSpreadOf(s[2]).index })()`)
  check(paired, 'tsthree.cbz pairs its 2nd and 3rd pages in one spread')
  call('window.__fol.goTo(1)')
  await settle()
  from = messages.length
  call('window.__fol.goTo(2, true)')
  await settle()
  check(!messages.slice(from).some((x) => x.type === 'log' && /did not land/.test(x.msg)) && storesFrom(from).length === 1,
    `a taken goTo to the other page of the shown spread arrives and saves (${JSON.stringify(storesFrom(from))})`)

  await checkSelectionEdges()
  await checkPdf()
  await checkOpenOrder()
  await checkOldWebView()

  // Every page error on this page, last so that every block above is covered. One benign message is let
  // through by its exact text: Chromium's ResizeObserver loop notice, from the resize above.
  const BENIGN = 'ResizeObserver loop completed with undelivered notifications.'
  for (const x of messages) if (x.type === 'log' && x.level === 'error' && !/^open: /.test(x.msg) && x.msg !== BENIGN) check(false, `page error: ${x.msg.split('\n')[0]}`)

  // The 5-minute boundary, on a page with a fake clock: the session ends by its own timer (no next open),
  // a switch inside the window counts, a switch after it does not and sends nothing more.
  console.log('telemetry clock')
  const timed = await newPage()
  const sent = []
  await timed.clock.install()
  await timed.exposeFunction('__toHost', (json) => sent.push(JSON.parse(json)))
  await timed.addInitScript(() => { if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) } })
  await timed.goto(PAGE_URL)
  const until = async (match, what) => {
    for (const t0 = Date.now(); Date.now() - t0 < TIMEOUT_MS; await new Promise((ok) => setTimeout(ok, 50))) { const x = sent.find(match); if (x) return x }
    throw new Error(`timed out waiting for ${what}`)
  }
  const openTimed = async (file) => {
    const from = sent.length
    await timed.evaluate((u) => window.__fol.openUrl(u, 'timed'), bookAt(file))
    // foliate's own timers run on the fake clock too: keep it moving in small steps until the book opens.
    for (const t0 = Date.now(); !sent.slice(from).some((x) => x.type === 'opened') && Date.now() - t0 < TIMEOUT_MS;) await timed.clock.runFor(50)
    return sent.slice(from).find((x) => x.type === 'opened')
  }
  const telemetry = () => sent.filter((x) => x.type === 'telemetry')
  await until((x) => x.type === 'ready', 'ready (timed)')
  check(!!(await openTimed('tsformat.fb2')), 'opened under the fake clock')
  await timed.clock.runFor(4 * 60 * 1000 + 59 * 1000)
  check(telemetry().length === 0, 'nothing is sent before 5 minutes')
  await timed.evaluate(() => window.__fol.flow('scrolled'))
  await timed.clock.runFor(2000)
  check(telemetry().length === 1 && telemetry()[0].switchedInFirst5Min === true && telemetry()[0].mode === 'scrolled',
    `a switch at 4:59 counts, the timer sends it at 5:00: ${JSON.stringify(telemetry())}`)
  check(!!(await openTimed('tsformat.fb2')), 'the same book reopened')
  await timed.clock.runFor(5 * 60 * 1000 + 1000)
  await timed.evaluate(() => window.__fol.flow('paginated'))
  await timed.clock.runFor(1000)
  check(telemetry().length === 2 && telemetry()[1].switchedInFirst5Min === false && telemetry()[1].mode === 'scrolled',
    `a switch after 5:00 is not counted and sends nothing more: ${JSON.stringify(telemetry())}`)
  // A late timer (a backgrounded WebView throttles them): the clock passes 5:00 without the timer firing,
  // and a switch then is still not counted.
  check(!!(await openTimed('tsformat.fb2')), 'reopened for a late timer')
  await timed.clock.setSystemTime(await timed.evaluate(() => Date.now()) + 6 * 60 * 1000)
  await timed.evaluate(() => window.__fol.flow('scrolled'))
  // setSystemTime moves Date only; the timer is still 5 minutes of ticks away.
  await timed.clock.runFor(5 * 60 * 1000 + 1000)
  check(telemetry().length === 3 && telemetry()[2].switchedInFirst5Min === false,
    `a switch past 5:00 before the late timer fires is not counted: ${JSON.stringify(telemetry().at(-1))}`)
} catch (e) {
  check(false, String(e?.message ?? e))
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n[check:v2-reader-formats] ${failures.length ? 'FAILED' : 'ok'}`)
process.exit(failures.length ? 1 : 0)
