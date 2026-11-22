import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { testLogin } from '../helpers/api'

// @v2 — the V2 reader page on its production route (#1225; the only /read since M5 #1031). A V2 upload's
// file bytes come from /me/v2/books/{id}/files/{fileId}/content into the
// frame (/reader-v2/frame.html: a no-store shell + the content-hashed page script). Skips when the probe
// answers 404 (a server without /me/v2) unless SYNC_E2E=1, as v2-sync.spec.ts. In CI it runs on the production build
// (`vite preview`, which serves the frame through the same handler as nginx's files).

const API_URL = process.env.API_URL ?? 'http://localhost:8080'
const API_HEADERS = { Host: 'general.localhost' }
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, '../fixtures/v2-sync.epub')
const FIRST_SECTION_TEXT = 'The Pond, paragraph 1.'
/** #1265: an `<img>` (alt "A red square") and an SVG `<image>` on its first page (fixtures.mjs `writeImageEpub`). */
const IMAGE_FIXTURE = path.resolve(__dirname, '../fixtures/v2-image.epub')

/** The text of every section frame foliate has loaded (its frames sit in a closed shadow root). */
const sectionText = (page: Page) =>
  Promise.all(page.frames().filter((f) => f.url().startsWith('blob:')).map((f) => f.evaluate(() => document.body?.innerText ?? '').catch(() => '')))
    .then((texts) => texts.join('\n'))
const status = (page: Page) => page.getByTestId('v2-status')
/** A button on the reader's bars: they hide while reading (#1263), Esc shows them. */
async function clickBar(page: Page, name: string) {
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name, exact: true }).click()
}

async function expectOpened(page: Page) {
  await expect(page.getByTestId('v2-heading')).toHaveText('E2E V2 sync', { timeout: 20_000 })
  await expect.poll(() => sectionText(page), { timeout: 15_000 }).toContain(FIRST_SECTION_TEXT)
  // The percent read, then the current contents entry's title (#1261): never a section number.
  await expect(status(page)).toHaveText(/^\d+% · The (Pond|Woods|Village)$/)
  await expect(page.getByRole('alert')).toHaveCount(0)
}

/** A signed-in context for `email`; skipped when /me/v2 answers 404 (unless SYNC_E2E=1). */
async function v2Context(browser: { newContext(): Promise<BrowserContext> }, email: string, answerBanner = true) {
  const context = await browser.newContext()
  // Answered, so the cookie banner is out of the way; #1292's spec leaves it up.
  if (answerBanner) await context.addInitScript(() => localStorage.setItem('cookieConsent', 'rejected'))
  await testLogin(context.request, email)
  const probe = await context.request.get(`${API_URL}/me/v2/status`, { headers: API_HEADERS })
  test.skip(probe.status() === 404 && process.env.SYNC_E2E !== '1', '/me/v2 is not mapped on this server')
  expect(probe.ok(), `GET /me/v2/status: ${probe.status()}`).toBeTruthy()
  return context
}

/** Upload on V2 (sha256, import, parts, complete); the bytes are readable once the content is complete. */
async function uploadFixture(page: Page, file = FIXTURE): Promise<string> {
  await page.goto('/en/library')
  await page.locator('.site-header__upload-btn').click()
  const imported = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/me\/v2\/books\/[0-9a-f-]{36}$/.test(r.url()))
  const completed = page.waitForResponse((r) => r.request().method() === 'POST' && /\/me\/v2\/books\/[0-9a-f-]{36}\/files\/[0-9a-f-]{36}\/content$/.test(r.url()))
  await page.locator('.upload-modal input[type="file"]').setInputFiles(file)
  const { id } = (await (await imported).json()) as { id: string }
  expect((await completed).ok()).toBeTruthy()
  return id
}

interface PageMessages {
  restored: { position: string }[]
  /** The page's saved entries: a highlight drawn by `addHighlights` is in every one after it. */
  store: { json: string }[]
  /** The answers to `addHighlights`: one status per highlight. */
  highlights: { highlights: { id: string; status: string }[] }[]
  /** The places the page reported (`moved`: the reader moved it, the save rule's own test). */
  /** `at`: the host window's performance.now() when it arrived. */
  relocate: { cfi: string; moved: boolean; at: number }[]
}

/** The page's `restored`, `store` and `highlights` messages, as the host's window receives them (the host shows neither here). */
async function collectPageMessages(page: Page) {
  await page.addInitScript(() => {
    if (window.top !== window) return
    const w = window as unknown as { __page: Record<string, unknown[]> }
    w.__page = { restored: [], store: [], highlights: [], relocate: [] }
    addEventListener('message', (e) => {
      try {
        const m = typeof e.data === 'string' ? JSON.parse(e.data) : null
        if (m?.type === 'restored' || m?.type === 'store' || m?.type === 'highlights' || m?.type === 'relocate') w.__page[m.type].push(m.type === 'relocate' ? { ...m, at: performance.now() } : m)
      } catch { /* not the page's */ }
    })
  })
  return () => page.evaluate(() => (window as unknown as { __page: PageMessages }).__page)
}

/** The words of the first paragraph on screen, centred, in page coordinates (the section frames sit in the reader frame). */
async function firstParagraphWords(page: Page) {
  for (const f of page.frames().filter((x) => x.url().startsWith('blob:'))) {
    const list = await f.evaluate((text) => {
      const p = Array.from(document.querySelectorAll('p')).find((x) => x.textContent?.includes(text))
      const node = p?.firstChild as Text | undefined
      if (!node) return null
      return Array.from(node.data.matchAll(/\p{L}+/gu)).map((m) => {
        const r = document.createRange()
        r.setStart(node, m.index!)
        r.setEnd(node, m.index! + m[0].length)
        const b = r.getBoundingClientRect()
        return { word: m[0], x: b.left + b.width / 2, y: b.top + b.height / 2 }
      })
    }, FIRST_SECTION_TEXT).catch(() => null)
    if (!list) continue
    const box = (await (await f.frameElement()).boundingBox())!
    return list.map((w) => ({ ...w, x: box.x + w.x, y: box.y + w.y }))
  }
  return []
}

/**
 * A point in the centre tap zone (30-70 % of the width) of the section on screen with no text within 10 px, between
 * the shown top bar (56 px) and footer (the bottom 100 px): a tap there is a `tap`, never a word, and reaches the page
 * whether the bars are shown or not. From the frame's own layout (its text boxes), not a constant.
 */
async function blankCentrePoint(page: Page) {
  const { width, height } = page.viewportSize()!
  for (const f of page.frames().filter((x) => x.url().startsWith('blob:'))) {
    // A frame can detach mid-loop (a section unloaded): skip it.
    const box = await f.frameElement().then((e) => e.boundingBox()).catch(() => null)
    if (!box) continue
    const p = await f.evaluate(({ ox, oy, width, height }) => {
      const boxes: DOMRect[] = []
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      while (w.nextNode()) {
        if (!w.currentNode.textContent?.trim()) continue
        const r = document.createRange()
        r.selectNodeContents(w.currentNode)
        boxes.push(...Array.from(r.getClientRects()))
      }
      const near = (x: number, y: number) => boxes.some((b) => x > b.left - 10 && x < b.right + 10 && y > b.top - 10 && y < b.bottom + 10)
      for (let py = 76; py < height - 100; py += 4) {
        for (const px of [0.5, 0.45, 0.55, 0.4, 0.6].map((k) => width * k)) {
          const x = px - ox, y = py - oy
          if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && !near(x, y)) return { x: px, y: py }
        }
      }
      return null
    }, { ox: box.x, oy: box.y, width, height }).catch(() => null)
    if (p) return p
  }
  throw new Error('no blank point in the centre zone of the section on screen')
}

/** Selects the first paragraph's characters `from`..`to` in the section on screen. */
async function selectInFirstParagraph(page: Page, from: number, to: number) {
  const done = await Promise.all(page.frames().filter((f) => f.url().startsWith('blob:')).map((f) => f.evaluate(([text, a, b]) => {
    const p = Array.from(document.querySelectorAll('p')).find((x) => x.textContent?.includes(text as string))
    if (!p?.firstChild) return false
    const range = document.createRange()
    range.setStart(p.firstChild, a as number)
    range.setEnd(p.firstChild, b as number)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    return true
  }, [FIRST_SECTION_TEXT, from, to]).catch(() => false)))
  expect(done.some(Boolean), 'the first paragraph to select').toBe(true)
}

/** A reader whose native language is Ukrainian (confirmed), and the translate service answered by this test. */
async function withTranslation(context: BrowserContext) {
  await context.addInitScript(() => {
    localStorage.setItem('textstack_native_language', 'uk')
    localStorage.setItem('textstack_native_language_confirmed', '1')
  })
  const asked: { text: string; sourceLang: string; targetLang: string; sentence?: string }[] = []
  await context.route('**/translate', async (route) => {
    asked.push(route.request().postDataJSON())
    await route.fulfill({ json: { translatedText: 'MOCK-TRANSLATION', sourceLang: 'en', targetLang: 'uk' } })
  })
  return asked
}

const email = (tag: string) => `e2e-${tag}-${Date.now()}-${test.info().repeatEachIndex}@textstack.app`

test.describe('V2 reader page @v2', () => {
  test.describe.configure({ timeout: 120_000 })

  test('a V2 upload opens from its book page, turns a page, and opens again after a reload', async ({ browser }) => {
    const context = await v2Context(browser, email('v2r'))
    const request = context.request
    const page = await context.newPage()
    const bookId = await uploadFixture(page)

    // M5 (#1031): the entry point is the book page's one Read button, the DEFAULT route /read, and it is V2.
    await page.goto(`/en/library/my/${bookId}`)
    await expect(page.getByRole('link', { name: 'Open in the V2 reader' })).toHaveCount(0)
    await page.getByRole('link', { name: /^(Start|Continue) Reading$/ }).click()
    await expect(page).toHaveURL(new RegExp(`/en/library/my/${bookId}/read(/[^/]+)?/?$`))
    await expect(page.locator('iframe[title="Book text"]')).toHaveAttribute('src', '/reader-v2/frame.html')
    await expectOpened(page)

    const before = await status(page).textContent()
    await clickBar(page, 'Next ›')
    await expect(status(page)).not.toHaveText(before ?? '')

    // The page script is cached (immutable), the shell never is.
    const shell = await request.get('/reader-v2/frame.html')
    expect(shell.headers()['cache-control']).toBe('no-store, no-transform')
    const src = (await shell.text()).match(/src="(\/reader-v2\/page\.[0-9a-f]{16}\.js)"/)?.[1]
    expect(src, 'the shell loads the page script').toBeTruthy()
    expect((await request.head(src!)).headers()['cache-control']).toContain('immutable')

    await page.reload()
    await expectOpened(page)

    // The default route as the old links name it (a chapter slug): V2 too, the slug ignored; /read-v2 an alias.
    for (const route of [`/en/library/my/${bookId}/read`, `/en/library/my/${bookId}/read/any-chapter`, `/en/library/my/${bookId}/read-v2`]) {
      await page.goto(route)
      await expect(page.locator('iframe[title="Book text"]')).toHaveAttribute('src', '/reader-v2/frame.html')
      await expectOpened(page)
    }
    await context.close()
  })

  // #1260: the theme and the size, changed in the settings panel, restyle the open book at once (the place
  // holds) and are this device's after a reload; the theme colours the bars too.
  test('readV2Settings_ThemeAndSizeChanged_AppliedLive_KeptAfterAReload', async ({ browser }) => {
    const context = await v2Context(browser, email('v2set'))
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)
    /** The first section's text size and background, as the frame renders them. */
    const look = async () => {
      for (const f of page.frames().filter((x) => x.url().startsWith('blob:'))) {
        const l = await f.evaluate((text) => (document.body?.innerText.includes(text)
          ? `${getComputedStyle(document.querySelector('p')!).fontSize} ${getComputedStyle(document.documentElement).backgroundColor}` : null), FIRST_SECTION_TEXT).catch(() => null)
        if (l) return l
      }
      return null
    }
    await expect.poll(look).toBe('20px rgb(255, 255, 255)')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    await clickBar(page, 'Reading settings')
    const panel = page.getByTestId('v2-settings')
    await panel.getByRole('button', { name: 'Dark' }).click()
    await panel.getByRole('button', { name: 'Larger text' }).click()
    await expect(panel.getByTestId('v2-font-size')).toHaveText('22px')
    await expect.poll(look).toBe('22px rgb(26, 26, 26)')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('.reader-top-bar')).toHaveCSS('color', 'rgb(224, 224, 224)')
    // The place held: same entry, its text still on screen. Not the percent: larger text makes more pages, so the
    // same place reads a lower percent.
    await expect(status(page)).toHaveText(/ · The Pond$/)
    await expect.poll(() => sectionText(page)).toContain(FIRST_SECTION_TEXT)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await panel.getByRole('button', { name: 'Close reading settings' }).click()
    await expect(panel).toHaveCount(0)

    await page.reload()
    await expectOpened(page)
    await expect.poll(look).toBe('22px rgb(26, 26, 26)')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await context.close()
  })

  // #1263: the bars hide while reading; keys and the bar's arrows turn the page; on desktop a click never does, the mouse shows the bars.
  test('readV2Chrome_DesktopClicksKeysAndTheBarsNext_TurnAndShowAsTheyShould', async ({ browser }) => {
    const context = await v2Context(browser, email('v2bars'))
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)
    const main = page.locator('main.v2-reader')
    await expect(main).toHaveAttribute('data-bars', 'hidden', { timeout: 10_000 })
    await expect(page.getByRole('link', { name: 'Back to the library' })).toHaveAttribute('href', '/en/library')

    const first = (await status(page).textContent()) ?? ''
    await page.keyboard.press('ArrowRight')
    await expect(status(page)).not.toHaveText(first)
    await page.keyboard.press('PageUp')
    await expect(status(page)).toHaveText(first)

    // Desktop (a fine pointer): a click in the book turns no page (a blank point in the centre, the page's own margins
    // on both edges); the mouse shows the bars and 3 s without a move hides them. Touch keeps the tap zones (tapZone.mjs).
    const frames = page.frames().filter((f) => f.url().startsWith('blob:'))
    const texts = await Promise.all(frames.map((f) => f.evaluate(() => document.body?.innerText ?? '').catch(() => '')))
    const section = frames[texts.findIndex((t) => t.includes(FIRST_SECTION_TEXT))]
    const line = (await section.locator('p').nth(0).boundingBox())!.y + 12
    const width = page.viewportSize()!.width
    const blank = await blankCentrePoint(page)
    await page.mouse.click(blank.x, blank.y)
    await page.mouse.click(10, line)
    await page.mouse.click(width - 10, line)
    await expect(main).toHaveAttribute('data-bars', 'shown')
    await expect(status(page)).toHaveText(first)
    await expect(main).toHaveAttribute('data-bars', 'hidden', { timeout: 5_000 })

    // Keys with focus inside the book, after a click in the page's margin: forwarded from the page's own document.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME')
    await page.keyboard.press('ArrowRight')
    await expect(status(page)).not.toHaveText(first)
    const turned = (await status(page).textContent()) ?? ''
    await page.keyboard.press('Escape')
    await expect(main).toHaveAttribute('data-bars', 'shown')
    await page.keyboard.press('ArrowLeft')
    await expect(status(page)).toHaveText(first)

    // The bar's Next keeps the bars under the cursor; a key after it still turns (and hides them).
    await clickBar(page, 'Next ›')
    await expect(status(page)).toHaveText(turned)
    await expect(main).toHaveAttribute('data-bars', 'shown')
    await page.keyboard.press('ArrowRight')
    await expect(status(page)).not.toHaveText(turned)
    await expect(main).toHaveAttribute('data-bars', 'hidden')
    await context.close()
  })

  // #1269: a word in the centre opens its popup, translated by the host (the page has no network) from the book's
  // language into the reader's, with the sentence; the place stays (the bars follow the mouse on desktop); its close closes it.
  test('readV2WordPopup_ACentreWordTapped_ItsTranslationInAPopup_TheBarsAndThePlaceStay', async ({ browser }) => {
    const context = await v2Context(browser, email('v2word'))
    const asked = await withTranslation(context)
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)
    const main = page.locator('main.v2-reader')
    await expect(main).toHaveAttribute('data-bars', 'hidden', { timeout: 10_000 })
    const before = (await status(page).textContent()) ?? ''

    const width = page.viewportSize()!.width
    const word = (await firstParagraphWords(page)).find((w) => w.x > width * 0.35 && w.x < width * 0.65)
    expect(word, 'a word in the centre zone').toBeTruthy()
    await page.mouse.click(word!.x, word!.y)
    const popup = page.locator('.word-popup')
    await expect(popup).toContainText(word!.word)
    await expect(popup.locator('.word-popup__translation')).toHaveText('MOCK-TRANSLATION')
    // The context is the tapped word's own sentence (not the paragraph's label sentence).
    const own = new RegExp(`\\b${word!.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    expect(asked.at(-1)).toMatchObject({ text: word!.word, sourceLang: 'en', targetLang: 'uk', sentence: expect.stringMatching(own) })
    await expect(status(page)).toHaveText(before)

    await popup.getByRole('button', { name: 'Close' }).first().click()
    await expect(popup).toHaveCount(0)
    await context.close()
  })

  // #1270: a word tapped is saved to the vocabulary (the legacy reader's auto-save), with its sentence, this book, its
  // title and the translation the popup fetched; the vocabulary list shows it.
  test('readV2VocabSave_ACentreWordTapped_SavedWithItsSentenceAndBook_InTheVocabularyList', async ({ browser }) => {
    const context = await v2Context(browser, email('v2vocab'))
    await withTranslation(context)
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)

    const width = page.viewportSize()!.width
    const word = (await firstParagraphWords(page)).find((w) => w.x > width * 0.35 && w.x < width * 0.65 && w.word.length > 2)
    expect(word, 'a word in the centre zone').toBeTruthy()
    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/me/v2/vocabulary/words'))
    const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/me\/v2\/vocabulary\/words\/[0-9a-f-]{36}$/.test(r.url()))
    await page.mouse.click(word!.x, word!.y)
    const put = await saved
    expect(put.ok(), `PUT word: ${put.status()} ${await put.text()}`).toBeTruthy()
    // The context is the tapped word's own sentence (C2's e2e, 32ca405e): it holds the word as a whole word.
    const own = new RegExp(`\\b${word!.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    expect(put.request().postDataJSON()).toMatchObject({
      word: word!.word, language: 'en',
      example: { bookId, bookTitle: 'E2E V2 sync', sentence: expect.stringMatching(own) },
    })
    // The translation follows the save (TR-2: it fills the untranslated card).
    await expect(page.locator('.word-popup__translation')).toHaveText('MOCK-TRANSLATION')
    const patch = await patched
    expect(patch.ok(), `PATCH word: ${patch.status()} ${await patch.text()}`).toBeTruthy()
    expect(patch.request().postDataJSON()).toMatchObject({ translation: 'MOCK-TRANSLATION' })

    await page.goto('/en/vocabulary')
    await expect(page.getByText(word!.word, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await context.close()
  })

  // #1271: a saved word is marked in the text by its stage (new: blue), its translation above it behind the legacy
  // reader's setting; the switch hides and shows the glosses; a reload marks it again from the reader's vocabulary.
  test('readV2Marks_AWordSaved_MarkedWithItsTranslation_TheSwitchHidesIt_AReloadMarksItAgain', async ({ browser }) => {
    const context = await v2Context(browser, email('v2marks'))
    await withTranslation(context)
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)

    const width = page.viewportSize()!.width
    const word = (await firstParagraphWords(page)).find((w) => w.x > width * 0.35 && w.x < width * 0.65 && w.word.length > 3)
    expect(word, 'a word in the centre zone').toBeTruthy()
    /** What the page draws over the shown section: each overlay's underline colour, label and the text under it. */
    const marks = () => {
      const frame = page.frames().find((f) => f.url().includes('/reader-v2/frame.html'))!
      return frame.evaluate(() => [...(document.querySelector('foliate-view') as unknown as { renderer: { getContents(): { overlayer?: { element: SVGElement } }[] } }).renderer.getContents()]
        .flatMap((c) => [...(c.overlayer?.element.children ?? [])].map((g) => ({
          // foliate's underline: the colour on the group of its rects.
          line: g.querySelector('rect[height="2"]')?.parentElement?.getAttribute('fill') ?? null,
          label: g.querySelector('text')?.textContent ?? null,
        }))))
    }
    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/me/v2/vocabulary/words'))
    await page.mouse.click(word!.x, word!.y)
    expect((await saved).ok()).toBeTruthy()
    await page.locator('.word-popup').getByRole('button', { name: 'Close' }).first().click()
    const blueWithGloss = (ms: { line: string | null; label: string | null }[]) => ms.filter((m) => m.line === 'rgba(59,130,246,0.5)' && m.label === 'MOCK-TRANSLATION').length
    await expect.poll(async () => blueWithGloss(await marks()), { timeout: 15_000 }).toBeGreaterThan(0)

    await clickBar(page, 'Reading settings')
    const sw = page.getByRole('switch', { name: 'Inline translations' })
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await sw.click()
    await expect.poll(async () => (await marks()).filter((m) => m.line === 'rgba(59,130,246,0.5)' && m.label === null).length).toBeGreaterThan(0)
    expect((await marks()).some((m) => m.label)).toBe(false)
    await sw.click()
    await expect.poll(async () => blueWithGloss(await marks())).toBeGreaterThan(0)
    await page.keyboard.press('Escape')

    await page.reload()
    await expectOpened(page)
    await expect.poll(async () => blueWithGloss(await marks()), { timeout: 15_000 }).toBeGreaterThan(0)
    await context.close()
  })

  // #1269: a selection opens the toolbar (highlight, translate, explain, copy; Listen comes with TTS, #1272);
  // Translate shows the host's translation; its close and Copy each end the selection in the book.
  test('readV2Selection_TheToolbar_TranslateThenCopy_EachEndsTheSelection', async ({ browser }) => {
    const context = await v2Context(browser, email('v2sel'))
    const asked = await withTranslation(context)
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)
    const collapsed = () => Promise.all(page.frames().filter((f) => f.url().startsWith('blob:')).map((f) => f.evaluate(() => document.getSelection()?.isCollapsed ?? true).catch(() => true)))
      .then((all) => all.every(Boolean))

    // "I went to the woods" (characters 23..42 of "The Pond, paragraph 1. I went to the woods …").
    await selectInFirstParagraph(page, 23, 42)
    const toolbar = page.locator('.selection-toolbar')
    await expect(toolbar).toBeVisible()
    for (const name of ['Translate selected text', 'Explain in context', 'Copy selected text']) await expect(toolbar.getByRole('button', { name })).toBeEnabled()
    await expect(toolbar.getByRole('button', { name: 'Listen to pronunciation' })).toBeEnabled() // #1272: Listen is in

    await toolbar.getByRole('button', { name: 'Translate selected text' }).click()
    const translation = page.locator('.translation-popup')
    await expect(translation).toContainText('MOCK-TRANSLATION')
    expect(asked.at(-1)).toMatchObject({ text: 'I went to the woods', sourceLang: 'en', targetLang: 'uk' })
    await translation.getByRole('button', { name: 'Close' }).first().click()
    await expect(translation).toHaveCount(0)
    await expect.poll(collapsed).toBe(true)

    await selectInFirstParagraph(page, 23, 42)
    await expect(toolbar).toBeVisible()
    await toolbar.getByRole('button', { name: 'Copy selected text' }).click()
    await expect(toolbar).toHaveCount(0)
    await expect.poll(collapsed).toBe(true)
    await context.close()
  })

  // #1261: the contents dialog jumps to an entry (saved as the reader's own move); the section controls name the
  // neighbouring entries by title. The book page's Contents opens the reader with the dialog open (`?contents=1`).
  test('readV2Toc_AnEntryChosenThenThePreviousSection_TheBookJumpsAndTheCurrentEntryFollows', async ({ browser }) => {
    const context = await v2Context(browser, email('v2toc'))
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}`)
    await page.getByRole('link', { name: 'Contents', exact: true }).click()
    await expectOpened(page)

    const dialog = page.getByRole('dialog', { name: 'Contents' })
    const entries = dialog.locator('li button')
    await expect(entries).toHaveText(['The Pond', 'The Woods', 'The Village'])
    const current = dialog.locator('[aria-current="true"]')
    await expect(current).toHaveText('The Pond')
    await expect(current).toBeFocused()

    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/me/v2/books/${bookId}/reading-state`))
    await entries.nth(2).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => sectionText(page), { timeout: 15_000 }).toContain('The Village, paragraph 1.')
    expect((await saved).ok()).toBeTruthy()
    // The last entry: only the one before it is offered, by its title.
    await expect(page.getByTestId('v2-prev-section')).toHaveText('‹ The Woods')
    await expect(page.getByTestId('v2-next-section')).toHaveCount(0)
    // The host marks a chosen entry at once; a page turn's relocate is the page's own word for the place.
    const landed = (await status(page).textContent()) ?? ''
    expect(landed).toMatch(/^\d+% · The Village$/)
    await page.keyboard.press('ArrowRight')
    await expect(status(page)).not.toHaveText(landed)
    await expect(status(page)).toHaveText(/^\d+% · The Village$/)

    await clickBar(page, 'Previous section: The Woods')
    await expect.poll(() => sectionText(page), { timeout: 15_000 }).toContain('The Woods, paragraph 1.')
    await expect(page.getByTestId('v2-prev-section')).toHaveText('‹ The Pond')
    await expect(page.getByTestId('v2-next-section')).toHaveText('The Village ›')

    await clickBar(page, 'Contents')
    await expect(current).toHaveText('The Woods')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Contents', exact: true })).toBeFocused()
    await context.close()
  })

  // #1316: at the end of a contents entry the reader shares that chapter with their assistant: the entry's own text
  // goes to /me/v2 as a share, the chat opens with the book and share ids, and only the owner can read the share.
  test('readV2Discuss_TheEndOfAChapter_ItsTextSharedThenTheChatOpensWithTheShareId_AFailedShareOpensNothing', async ({ browser }) => {
    const context = await v2Context(browser, email('v2discuss'))
    // The test account has no assistant connected: one is answered for it. The chat itself is never loaded.
    // Answered for the API's origin, so with the CORS headers the browser asks of it.
    await context.route('**/me/oauth/grants', (r) => r.fulfill({
      headers: { 'access-control-allow-origin': r.request().headers().origin ?? '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'authorization, content-type' },
      json: r.request().method() === 'OPTIONS' ? {} : { items: [{ id: 'g1', clientId: 'c1', clientName: 'Claude', scopes: [], createdAt: '2026-11-15T00:00:00Z', lastUsedAt: null }] },
    }))
    await context.route('https://claude.ai/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>chat</title>' }))
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)
    const share = page.getByTestId('v2-discuss-share')
    await expect(share).toHaveCount(0)

    // To the end of the first entry: the block names the entry whose end is on screen.
    for (let i = 0; i < 40 && !(await share.count()); i++) {
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(400)
    }
    await expect(share).toHaveAccessibleName('Discuss the chapter The Pond with your assistant')

    // Offline: said, with a retry; nothing to open.
    const sharesUrl = `**/me/v2/books/${bookId}/shares`
    await context.route(sharesUrl, (r) => r.abort('internetdisconnected'))
    await share.click()
    await expect(page.getByTestId('v2-discuss').getByRole('alert')).toHaveText(/You are offline, so the chapter was not shared\./)
    await expect(page.getByTestId('v2-discuss-open')).toHaveCount(0)
    await context.unroute(sharesUrl)

    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/me/v2/books/${bookId}/shares`))
    await share.click()
    const response = await posted
    expect(response.status()).toBe(201)
    const sent = response.request().postDataJSON() as { fileId: string; chapterKey: string; chapterTitle: string; chapterText: string }
    expect({ chapterKey: sent.chapterKey, chapterTitle: sent.chapterTitle }).toEqual({ chapterKey: 'toc-0', chapterTitle: 'The Pond' })
    expect(sent.fileId).toMatch(/^[0-9a-f-]{36}$/)
    expect(sent.chapterText).toContain(FIRST_SECTION_TEXT)
    expect(sent.chapterText).not.toContain('The Woods, paragraph 1.')
    const { id: shareId } = (await response.json()) as { id: string }

    await expect(page.getByTestId('v2-discuss').getByRole('status')).toHaveText(/The chapter is shared with your assistant\./)
    const popup = page.waitForEvent('popup')
    await page.getByTestId('v2-discuss-open').click()
    const chat = new URL((await popup).url())
    expect(chat.origin + chat.pathname).toBe('https://claude.ai/new')
    expect(chat.searchParams.get('q')).toBe(
      `I'm reading "E2E V2 sync" in TextStack, at the chapter "The Pond". Let's talk about it.\n\n(TextStack: book ${bookId}, share ${shareId})`)

    // What the assistant's tool reads: the owner's share as sent; another account's read finds nothing.
    const read = await context.request.get(`${API_URL}/me/v2/shares/${shareId}`, { headers: API_HEADERS })
    expect(read.status()).toBe(200)
    expect(((await read.json()) as { chapterText: string }).chapterText).toBe(sent.chapterText)
    const other = await v2Context(browser, email('v2discuss-other'))
    const theirs = await other.request.get(`${API_URL}/me/v2/shares/${shareId}`, { headers: API_HEADERS })
    expect(theirs.status()).toBe(404)
    expect(await theirs.text()).not.toContain(FIRST_SECTION_TEXT)
    await other.close()
    await context.close()
  })

  // #1316 review: with two assistants connected the pick opens upward from the pill at the bottom of the screen: its
  // items are inside the window, at a desktop and a phone size (live geometry, never a pixel value).
  test('readV2Discuss_TwoAssistantsConnected_ThePickMenuIsInsideTheWindow_AtTwoSizes', async ({ browser }) => {
    const context = await v2Context(browser, email('v2discussmenu'))
    await context.route('**/me/oauth/grants', (r) => r.fulfill({
      headers: { 'access-control-allow-origin': r.request().headers().origin ?? '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'authorization, content-type' },
      json: r.request().method() === 'OPTIONS' ? {} : { items: ['Claude', 'ChatGPT'].map((clientName, i) => ({ id: `g${i}`, clientId: `c${i}`, clientName, scopes: [], createdAt: '2026-11-15T00:00:00Z', lastUsedAt: null })) },
    }))
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size)
      await page.goto(`/en/library/my/${bookId}/read-v2`)
      await expectOpened(page)
      await page.evaluate(() => localStorage.removeItem('chapterReview.assistant'))
      const share = page.getByTestId('v2-discuss-share')
      for (let i = 0; i < 60 && !(await share.count()); i++) {
        await page.keyboard.press('ArrowRight')
        await page.waitForTimeout(400)
      }
      await share.click()
      await page.getByTestId('v2-discuss-open').click()
      const items = page.getByRole('menu', { name: 'Discuss in' }).getByRole('menuitem')
      await expect(items).toHaveText(['Claude', 'ChatGPT'])
      for (const item of await items.all()) {
        const box = (await item.boundingBox())!
        const where = `${JSON.stringify(box)} in ${JSON.stringify(size)}`
        expect(box.x, where).toBeGreaterThanOrEqual(0)
        expect(box.y, where).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width, where).toBeLessThanOrEqual(size.width)
        expect(box.y + box.height, where).toBeLessThanOrEqual(size.height)
        // And on top there: a click at its middle reaches it.
        expect(await item.evaluate((el, [x, y]) => el.contains(document.elementFromPoint(x, y)), [box.x + box.width / 2, box.y + box.height / 2]), `on top: ${where}`).toBe(true)
      }
    }
    await context.close()
  })

  // #1315: the reader searches the open book from the bar. The page searches every section and lists each hit with the
  // text around it and its section's title; a hit chosen is where the book goes (saved, as any place the reader chose),
  // drawn over its text; clearing the search removes what was drawn.
  test('readV2Search_AQueryTyped_ItsHitsListedWithContext_OneChosen_TheBookJumpsThereAndDrawsIt_ClearedItGoes', async ({ browser }) => {
    const context = await v2Context(browser, email('v2search'))
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)

    await clickBar(page, 'Search')
    const dialog = page.getByRole('dialog', { name: 'Search in this book' })
    const field = dialog.getByRole('searchbox', { name: 'Search in this book' })
    await expect(field).toBeFocused()
    // Any case; one hit in each of the three sections, far from each one's first screen.
    await field.fill('PARAGRAPH 40. i went')
    const HIT = 'paragraph 40. I went'
    // foliate's excerpt: the text before the hit in its paragraph, 50 characters after it and an ellipsis.
    const after = `${' to the woods because I wished to live deliberately, to front only'.slice(0, 50)}…`
    const rows = dialog.getByTestId('v2-search-results').locator('li button')
    await expect(rows).toHaveText(['The Pond', 'The Woods', 'The Village'].map((title) => `${title}${title}, ${HIT}${after}`))
    await expect(rows.nth(2).locator('mark')).toHaveText(HIT)
    await expect(dialog.getByTestId('v2-search-status')).toHaveText('Results: 3')
    // #1267's baseline holds with the drawer open and its results listed.
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag21a']).analyze()
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' > ')).join(' | ')}`)).toEqual([])

    /**
     * The hit in the section on screen, from the reader frame's own view: whether its text is inside the viewport, its
     * boxes, and the boxes the page drew for search hits there (each in the section frame's coordinates).
     */
    const hitOnScreen = () => page.frames().find((f) => f.url().includes('/reader-v2/'))!.evaluate((text) => {
      const view = document.querySelector('foliate-view') as unknown as { renderer: { getContents(): { doc: Document; overlayer?: { element: SVGElement } }[] } }
      const box = (q: { left: number; top: number; width: number; height: number }) => [q.left, q.top, q.width, q.height].map(Math.round).join()
      for (const c of view.renderer.getContents()) {
        const walker = c.doc.createTreeWalker(c.doc.body, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode as Text
          const at = node.data.indexOf(text)
          if (at < 0) continue
          const range = c.doc.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + text.length)
          const b = range.getBoundingClientRect(), frame = c.doc.defaultView!.frameElement!.getBoundingClientRect()
          return {
            section: node.data.slice(0, at),
            inView: frame.left + b.left >= 0 && frame.left + b.right <= innerWidth && frame.top + b.top >= 0 && frame.top + b.bottom <= innerHeight,
            boxes: Array.from(range.getClientRects()).map(box),
            drawn: Array.from(c.overlayer?.element.querySelectorAll(':scope > g[fill="#f97316"] > rect') ?? []).map((r) => box({ left: +r.getAttribute('x')!, top: +r.getAttribute('y')!, width: +r.getAttribute('width')!, height: +r.getAttribute('height')! })),
          }
        }
      }
      return null
    }, HIT)
    // Before the jump the book is on its first screen: the hit there (The Pond's) is drawn, off screen.
    expect((await hitOnScreen())?.inView).toBe(false)

    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/me/v2/books/${bookId}/reading-state`))
    await rows.nth(2).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => sectionText(page), { timeout: 15_000 }).toContain('The Village, paragraph 40.')
    expect((await saved).ok()).toBeTruthy()
    await expect(status(page)).toHaveText(/^\d+% · The Village$/)
    // The hit chosen is on screen, and drawn exactly over its text.
    await expect.poll(async () => {
      const h = await hitOnScreen()
      return h && { section: h.section, inView: h.inView, drawn: h.boxes.length > 0 && h.boxes.every((b) => h.drawn.includes(b)) }
    }, { timeout: 15_000 }).toEqual({ section: 'The Village, ', inView: true, drawn: true })

    // Opened again: the same search and results, nothing typed. Cleared: no results, and the page removes what it drew.
    await clickBar(page, 'Search')
    await expect(field).toHaveValue('PARAGRAPH 40. i went')
    await expect(rows).toHaveCount(3)
    await dialog.getByRole('button', { name: 'Clear search' }).click()
    await expect(rows).toHaveCount(0)
    await expect.poll(async () => (await hitOnScreen())?.drawn, { timeout: 15_000 }).toEqual([])
    // One letter is no query yet, and the status line says so; a query with no hit says that.
    await field.fill('w')
    await expect(dialog.getByTestId('v2-search-status')).toHaveText('Type at least 2 characters')
    await field.fill('no such words here')
    await expect(dialog.getByTestId('v2-search-status')).toHaveText('No results')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused()
    await context.close()
  })

  // #1312: a highlight in a colour, recoloured, given a note, listed, jumped to (from the list and by `?highlight=`),
  // deleted: each change one write on /me/v2, the deletion a tombstone.
  test('readV2Highlights_CreateRecolourNoteJumpAndDelete_EachWrittenTheDeletionATombstone', async ({ browser }) => {
    const context = await v2Context(browser, email('v2hl'))
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)
    // Offered once the server's highlights are in (the Highlight button).
    await expect(page.getByRole('button', { name: 'Highlight', exact: true })).toHaveCount(1, { timeout: 15_000 })

    /** A word of the first paragraph in the centre tap zone (an edge turns the page): its offsets and page point. */
    const centreWord = async () => {
      const width = page.viewportSize()!.width
      for (const f of page.frames().filter((x) => x.url().startsWith('blob:'))) {
        // A frame can detach mid-loop (a section unloaded after a reload): skip it.
        const box = await f.frameElement().then((e) => e.boundingBox()).catch(() => null)
        if (!box) continue
        const w = await f.evaluate(({ text, ox, lo, hi }) => {
          const node = Array.from(document.querySelectorAll('p')).find((x) => x.textContent?.includes(text))?.firstChild as Text | undefined
          for (const m of node ? node.data.matchAll(/\p{L}{4,}/gu) : []) {
            const r = document.createRange()
            r.setStart(node!, m.index!)
            r.setEnd(node!, m.index! + m[0].length)
            const b = r.getBoundingClientRect()
            const x = ox + b.left + b.width / 2
            if (x > lo && x < hi && b.width > 0) return { word: m[0], start: m.index!, end: m.index! + m[0].length, x: b.left + b.width / 2, y: b.top + b.height / 2 }
          }
          return null
        }, { text: FIRST_SECTION_TEXT, ox: box.x, lo: width * 0.35, hi: width * 0.65 }).catch(() => null)
        if (w) return { ...w, x: box.x + w.x, y: box.y + w.y }
      }
      throw new Error('no word of the first paragraph in the centre zone')
    }
    const annotationWrite = (method: string) => page.waitForResponse((r) => r.request().method() === method && /\/me\/v2\/annotations\/[0-9a-f-]{36}$/.test(r.url()))

    // Create, green, from the selection toolbar.
    const w = await centreWord()
    const created = annotationWrite('PUT')
    await selectInFirstParagraph(page, w.start, w.end)
    await page.getByRole('button', { name: 'Highlight green' }).click()
    const createdAnswer = await created
    expect(createdAnswer.ok(), `PUT annotation: ${createdAnswer.status()}`).toBeTruthy()
    const { id, color, selectedText } = (await createdAnswer.json()) as { id: string; color: string; selectedText: string }
    expect([color, selectedText]).toEqual(['green', w.word])

    // A tap on it: its editor. Recolour, then a note: each one write, the note kept with the colour.
    await page.mouse.click(w.x, w.y)
    const editor = page.locator('.pdf-hl-popup')
    await expect(editor).toContainText(w.word)
    const recoloured = annotationWrite('PUT')
    await editor.getByRole('button', { name: 'blue' }).click()
    expect(await (await recoloured).json()).toMatchObject({ id, color: 'blue', noteText: null })
    const noted = annotationWrite('PUT')
    await editor.getByPlaceholder('Add a note...').fill('an e2e note')
    await editor.getByRole('button', { name: 'Save' }).click()
    expect(await (await noted).json()).toMatchObject({ id, color: 'blue', noteText: 'an e2e note' })
    await expect(editor).toHaveCount(0)

    // Away to another section, then back by the list (the Highlights tab beside Contents).
    await clickBar(page, 'Next section: The Woods')
    await expect(status(page)).toHaveText(/^\d+% · The Woods$/)
    await clickBar(page, 'Contents')
    await page.getByRole('tab', { name: /Highlights/ }).click()
    const item = page.getByTestId('v2-highlights-list').getByRole('button')
    await expect(item).toHaveCount(1)
    await expect(item).toContainText(w.word)
    await expect(item).toContainText('an e2e note')
    const jumped = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/me/v2/books/${bookId}/reading-state`))
    await item.click()
    await expect(status(page)).toHaveText(/^\d+% · The Pond$/)
    // The jump is the reader's choice: its place is saved.
    expect((await jumped).ok()).toBeTruthy()

    // The deep link: the book saved at The Woods, opened at the highlight.
    const away = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/me/v2/books/${bookId}/reading-state`))
    await clickBar(page, 'Next section: The Woods')
    expect((await away).ok()).toBeTruthy()
    await page.goto(`/en/library/my/${bookId}/read-v2?highlight=${id}`)
    await expect(page.getByTestId('v2-heading')).toHaveText('E2E V2 sync', { timeout: 20_000 })
    await expect(status(page)).toHaveText(/^\d+% · The Pond$/, { timeout: 20_000 })
    // Handled: the parameter is gone (replaced, no history entry), so a reload opens at the saved place, no jump.
    await expect(page).not.toHaveURL(/[?&]highlight=/)

    // Delete from its editor: a DELETE, the tombstone; the list is empty.
    const again = await centreWord()
    await page.mouse.click(again.x, again.y)
    const deleted = annotationWrite('DELETE')
    await page.locator('.pdf-hl-popup').getByRole('button', { name: 'Delete highlight' }).click()
    const tomb = (await (await deleted).json()) as { id: string; deletedAt: string | null }
    expect(tomb.id).toBe(id)
    expect(tomb.deletedAt).not.toBeNull()
    await clickBar(page, 'Contents')
    await page.getByRole('tab', { name: /Highlights/ }).click()
    await expect(page.getByTestId('v2-highlights-list').getByRole('button')).toHaveCount(0)
    await expect(page.getByTestId('v2-not-saved')).toHaveCount(0)
    await context.close()
  })

  // #1314: a bookmark at the place on screen is the book's annotation of colour `bookmark` (its text: the first words
  // there). Listed beside Contents and Highlights, jumped to, there on another browser, removed as a tombstone.
  test('readV2Bookmarks_AddJumpSecondBrowserAndRemove_AnAnnotationOfColourBookmarkThenATombstone', async ({ browser }) => {
    const who = email('v2bm')
    const context = await v2Context(browser, who)
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)
    const annotationWrite = (method: string) => page.waitForResponse((r) => r.request().method() === method && /\/me\/v2\/annotations\/[0-9a-f-]{36}$/.test(r.url()))
    const stateWrite = () => page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/me/v2/books/${bookId}/reading-state`))
    /** The bars' bookmark button: one name ("Bookmark"), pressed while the place being read has one. */
    const button = (p: Page) => p.getByTestId('v2-bookmark')
    const openBookmarks = async (p: Page) => {
      await clickBar(p, 'Contents')
      await p.getByRole('tab', { name: /Bookmarks/ }).click()
      return p.getByTestId('v2-bookmarks-list')
    }

    // Offered once the server's annotations are in. Add: one write, the row itself.
    await expect(button(page)).toBeEnabled({ timeout: 15_000 })
    await expect(button(page)).toHaveAttribute('aria-pressed', 'false')
    const created = annotationWrite('PUT')
    await page.keyboard.press('Escape')
    await button(page).click()
    const createdAnswer = await created
    expect(createdAnswer.ok(), `PUT annotation: ${createdAnswer.status()}`).toBeTruthy()
    const row = (await createdAnswer.json()) as { id: string; color: string; selectedText: string; noteText: string | null; fileId: string; locator: { scheme: string; value: string; quote: string }; deletedAt: string | null }
    expect([row.color, row.noteText, row.deletedAt, row.locator.scheme]).toEqual(['bookmark', null, null, 'epub-cfi'])
    // Its text is the first words on screen (the book opens at its first section), and the locator's quote their start.
    const shown = (await sectionText(page)).replace(/\s+/g, '')
    expect(shown.startsWith(row.selectedText.replace(/\s+/g, '')), `"${row.selectedText}" opens the screen`).toBe(true)
    expect(row.selectedText.length).toBeGreaterThan(20)
    expect(row.selectedText.startsWith(row.locator.quote)).toBe(true)
    expect(row.locator.value).toMatch(/^epubcfi\(/)
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true')

    // Away: none on that screen. Back by the list: the jump is the reader's choice, its place saved.
    await clickBar(page, 'Next section: The Woods')
    await expect(status(page)).toHaveText(/^\d+% · The Woods$/)
    await expect(button(page)).toBeEnabled({ timeout: 15_000 })
    await expect(button(page)).toHaveAttribute('aria-pressed', 'false')
    const list = await openBookmarks(page)
    await expect(list.getByTestId('v2-bookmark-row')).toHaveCount(1)
    await expect(list.getByTestId('v2-bookmark-row')).toHaveText(row.selectedText.trim())
    // A bookmark is not a highlight: that tab stays empty.
    await page.getByRole('tab', { name: /Highlights/ }).click()
    await expect(page.getByTestId('v2-highlights-list').getByRole('button')).toHaveCount(0)
    await page.getByRole('tab', { name: /Bookmarks/ }).click()
    const jumped = stateWrite()
    await list.getByTestId('v2-bookmark-row').click()
    await expect(status(page)).toHaveText(/^\d+% · The Pond$/)
    expect((await jumped).ok()).toBeTruthy()
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('v2-not-saved')).toHaveCount(0)

    // Another browser, same account: the bookmark comes from the server, is listed and is the one on screen; nothing
    // is written back for it.
    const other = await v2Context(browser, who)
    const second = await other.newPage()
    const rewritten = second.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/me/v2/annotations/'), { timeout: 8_000 }).then(() => true, () => false)
    await second.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(second)
    await expect(button(second)).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
    await expect((await openBookmarks(second)).getByTestId('v2-bookmark-row')).toHaveText(row.selectedText.trim())
    expect(await rewritten, 'the server\'s bookmark is not written back').toBe(false)
    await other.close()

    // The button removes the one here: a DELETE, the tombstone (still the bookmark's row); the button adds again.
    const deleted = annotationWrite('DELETE')
    await page.keyboard.press('Escape')
    await button(page).click()
    const tomb = (await (await deleted).json()) as { id: string; color: string; deletedAt: string | null }
    expect([tomb.id, tomb.color]).toEqual([row.id, 'bookmark'])
    expect(tomb.deletedAt).not.toBeNull()
    await expect(button(page)).toBeEnabled({ timeout: 15_000 })
    await expect(button(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('v2-not-saved')).toHaveCount(0)

    // One that is not here (the reader is in another chapter) is removed from its row in the list: the same tombstone.
    const again = annotationWrite('PUT')
    await page.keyboard.press('Escape')
    await button(page).click()
    const second2 = (await (await again).json()) as { id: string; selectedText: string }
    expect(second2.id).not.toBe(row.id)
    await clickBar(page, 'Next section: The Woods')
    await expect(status(page)).toHaveText(/^\d+% · The Woods$/)
    await expect(button(page)).toBeEnabled({ timeout: 15_000 })
    await expect(button(page)).toHaveAttribute('aria-pressed', 'false')
    const rows = await openBookmarks(page)
    await expect(rows.getByTestId('v2-bookmark-row')).toHaveCount(1)
    const removed = annotationWrite('DELETE')
    await rows.getByRole('button', { name: `Remove bookmark: ${second2.selectedText.trim()}` }).click()
    const tomb2 = (await (await removed).json()) as { id: string; color: string; deletedAt: string | null }
    expect([tomb2.id, tomb2.color]).toEqual([second2.id, 'bookmark'])
    expect(tomb2.deletedAt).not.toBeNull()
    await expect(rows.getByTestId('v2-bookmark-row')).toHaveCount(0)
    await expect(page.getByTestId('v2-not-saved')).toHaveCount(0)

    // After a reload the server's feed has no live bookmark: none listed, none here. (The book opens where it was left, at The Woods.)
    await page.reload()
    await expect(page.getByTestId('v2-heading')).toHaveText('E2E V2 sync', { timeout: 20_000 })
    await expect(status(page)).toHaveText(/^\d+% · The Woods$/, { timeout: 20_000 })
    await expect(button(page)).toBeEnabled({ timeout: 15_000 })
    await expect(button(page)).toHaveAttribute('aria-pressed', 'false')
    await expect((await openBookmarks(page)).getByTestId('v2-bookmark-row')).toHaveCount(0)
    await context.close()
  })

  // #1226: position and highlights on /me/v2 through the shared client, not in this browser's storage.
  test('readV2Chrome_CookieBannerUnanswered_TheBottomBarSitsAboveItAndNextTurns', async ({ browser }) => {
    const context = await v2Context(browser, email('v2banner'), false)
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)
    const banner = page.locator('.cookie-banner')
    await expect(banner).toBeVisible()
    const first = (await status(page).textContent()) ?? ''
    await page.keyboard.press('Escape')
    const next = page.getByRole('button', { name: 'Next ›', exact: true })
    // Polled: the bar slides in.
    await expect.poll(async () => {
      const [bar, box] = [await page.locator('.reader-footer').boundingBox(), await banner.boundingBox()]
      return !!bar && !!box && bar.y + bar.height <= box.y + 1
    }).toBe(true)
    await next.click()
    await expect(status(page)).not.toHaveText(first)
    // Answered: the bar is back at the bottom edge.
    await page.getByRole('button', { name: 'Reject analytics', exact: true }).click()
    await expect(banner).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect.poll(async () => { const b = await page.locator('.reader-footer').boundingBox(); return b ? Math.round(b.y + b.height) : 0 }).toBe(page.viewportSize()!.height)
  })

  // #1265: an image tapped in the middle zone opens full screen inside the reader frame (no CSP change: the section's
  // own blob: image), never a turn or a word; the wheel zooms; Escape and the close button close it, and the place
  // stays. Tapped on an edge, it is a tap the host turns by.
  test('readV2Lightbox_AnImageTapped_OpensFullScreen_ZoomsAndClosesByEscapeAndClose_ThePlaceStays_AnEdgeTapTurns', async ({ browser }) => {
    const context = await v2Context(browser, email('v2img'))
    const page = await context.newPage()
    const bookId = await uploadFixture(page, IMAGE_FIXTURE)
    // The page's taps, as the host window receives them.
    await page.addInitScript(() => {
      if (window.top !== window) return
      const w = window as unknown as { __taps: number[] }
      w.__taps = []
      addEventListener('message', (e) => {
        try {
          const m = typeof e.data === 'string' ? JSON.parse(e.data) : null
          if (m?.type === 'tap') w.__taps.push(m.x)
        } catch { /* not the page's */ }
      })
    })
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expect(page.getByTestId('v2-heading')).toHaveText('TS IMAGE', { timeout: 20_000 })
    await expect(page.getByRole('alert')).toHaveCount(0)
    const main = page.locator('main.v2-reader')
    await expect(main).toHaveAttribute('data-bars', 'hidden', { timeout: 10_000 })
    await expect(status(page)).toHaveText(/^\d+%/)
    const before = (await status(page).textContent()) ?? ''

    /** The image in page px (its section frame sits in the reader frame): a point of it in the middle zone, its left, its blob: source. */
    const image = async () => {
      for (const f of page.frames().filter((x) => x.url().startsWith('blob:'))) {
        const r = await f.evaluate(() => {
          const img = document.querySelector('img')
          const b = img?.getBoundingClientRect()
          return img && b && b.width > 0 && b.left >= 0 && b.right <= innerWidth ? { left: b.left, right: b.right, y: b.top + b.height / 2, src: img.currentSrc } : null
        }).catch(() => null)
        if (!r) continue
        const box = (await (await f.frameElement()).boundingBox())!
        const width = page.viewportSize()!.width
        const [left, right] = [box.x + r.left, box.x + r.right]
        // The middle zone is 25-75 % of the width (tapZone.mjs).
        const x = Math.min(right - 8, width * 0.75 - 20, Math.max((left + right) / 2, width * 0.25 + 20))
        expect(x > left && x < right, 'a point of the image in the middle zone').toBe(true)
        return { src: r.src, left, x, y: box.y + r.y }
      }
      return null
    }
    await expect.poll(image, { timeout: 15_000 }).not.toBeNull()
    const img = (await image())!
    const reader = page.frameLocator('iframe[title="Book text"]')
    const dialog = reader.getByRole('dialog', { name: 'A red square' })
    const scale = () => dialog.locator('img').evaluate((el) => Number(/scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1]))

    await page.mouse.click(img.x, img.y)
    await expect(dialog).toBeVisible()
    expect(await dialog.locator('img').getAttribute('src')).toBe(img.src)
    expect(img.src).toMatch(/^blob:/)
    await expect(page.locator('.word-popup')).toHaveCount(0)
    expect(await scale()).toBe(1)
    await page.mouse.move(img.x, img.y)
    await page.mouse.wheel(0, -300)
    await expect.poll(scale).toBeGreaterThan(1.5)
    // A key while it is open turns nothing; Escape closes it.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(status(page)).toHaveText(before)
    await expect(main).toHaveAttribute('data-bars', 'hidden')

    // Reopened at scale 1; its close button closes it.
    await page.mouse.click(img.x, img.y)
    await expect(dialog).toBeVisible()
    expect(await scale()).toBe(1)
    // #1267: the open lightbox has no axe violation; Tab and Shift+Tab never leave it for the hidden bars (the host's
    // chrome is inert meanwhile); its close button is named in the reader's language (the host's `labels`).
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag21a']).analyze()
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' > ')).join(' | ')}`)).toEqual([])
    // From inside the dialog (the page keeps Tab) and from the host document (the gap: focus outside the frame), focus
    // ends in the lightbox each time: the host's focus on the reader frame, the frame's inside the dialog; never the
    // chrome (bars, states, skip link, the finish block).
    const readerFrame = page.frames().find((f) => f.url().includes('/reader-v2/frame'))!
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'focus-host', 'Tab', 'Tab', 'Shift+Tab']) {
      if (key === 'focus-host') { await main.focus(); continue }
      await page.keyboard.press(key)
      expect(await page.evaluate(() => !!document.activeElement?.closest('header, footer, .v2-reader__notices, .skip-link, .v2-reader__finish')), `host chrome focused after ${key}`).toBe(false)
      expect(await page.evaluate(() => document.activeElement?.getAttribute('title')), `the reader frame focused after ${key}`).toBe('Book text')
      expect(await readerFrame.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), `focus in the dialog after ${key}`).toBe(true)
    }
    await dialog.getByRole('button', { name: 'Close image', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(status(page)).toHaveText(before)

    // On the left edge zone: a `tap` there (the host's edge rule turns by it, the chrome spec above), not the lightbox.
    const width = page.viewportSize()!.width
    expect(img.left + 8, 'the image reaches into the left edge zone').toBeLessThan(width * 0.25)
    const taps = () => page.evaluate(() => (window as unknown as { __taps: number[] }).__taps)
    const seen = (await taps()).length
    await page.mouse.click(img.left + 8, img.y)
    await expect.poll(async () => (await taps()).slice(seen)).toEqual([expect.any(Number)])
    expect((await taps()).at(-1)!).toBeLessThan(width * 0.25)
    await expect(dialog).toHaveCount(0)
    await context.close()
  })

  test('readV2Sync_ReloadThenASecondBrowserContext_SamePlaceAndTheHighlightDrawn', async ({ browser }) => {
    const who = email('v2rs')
    const context = await v2Context(browser, who)
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    const messages = await collectPageMessages(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)

    // Read: the moved-to place is written to the server on the book's revision.
    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/me/v2/books/${bookId}/reading-state`))
    const before = await status(page).textContent()
    await clickBar(page, 'Next ›')
    await expect(status(page)).not.toHaveText(before ?? '')
    expect((await saved).ok()).toBeTruthy()
    const place = await status(page).textContent()
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('v2reader:store:')))).toEqual([])

    await page.reload()
    await expect(page.getByTestId('v2-heading')).toHaveText('E2E V2 sync', { timeout: 20_000 })
    await expect.poll(async () => (await messages()).restored.at(-1)?.position, { timeout: 15_000 }).toBe('restored')
    await expect(status(page)).toHaveText(place ?? '')

    // Highlight: a selection in the section on screen, written as an epub-cfi annotation.
    const selected = await Promise.all(page.frames().filter((f) => f.url().startsWith('blob:')).map((f) => f.evaluate(() => {
      const node = Array.from(document.querySelectorAll('p')).map((p) => p.firstChild).find((n) => (n?.textContent?.trim().length ?? 0) > 12)
      if (!node) return false
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, 12)
      document.getSelection()!.removeAllRanges()
      document.getSelection()!.addRange(range)
      return true
    }).catch(() => false)))
    expect(selected.some(Boolean), 'a paragraph to select').toBe(true)
    const put = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/me\/v2\/annotations\/[0-9a-f-]{36}$/.test(r.url()))
    // selectionchange is async: the page keeps the last selection it saw.
    await page.waitForTimeout(200)
    await clickBar(page, 'Highlight')
    const answer = await put
    expect(answer.ok(), `PUT annotation: ${answer.status()}`).toBeTruthy()
    const { id } = (await answer.json()) as { id: string }
    await expect(page.getByTestId('v2-not-saved')).toHaveCount(0)

    // Another browser, same account: the highlight comes back from the server and is drawn (addHighlights checks its
    // text there); the page's next save (a page turn) carries it, written by nothing (the server already holds it).
    const other = await v2Context(browser, who)
    const second = await other.newPage()
    const there = await collectPageMessages(second)
    await second.goto(`/en/library/my/${bookId}/read-v2`)
    await expect.poll(async () => (await there()).restored.at(-1)?.position, { timeout: 20_000 }).toBe('restored')
    await expect.poll(async () => (await there()).highlights.flatMap((m) => m.highlights), { timeout: 20_000 }).toContainEqual({ id, status: 'restored' })
    const annotationPut = second.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/me/v2/annotations/'), { timeout: 3_000 }).then(() => true, () => false)
    await expect.poll(async () => {
      await clickBar(second, 'Next ›')
      return (await there()).store.some((m) => (JSON.parse(m.json).highlights as { id: string }[]).some((h) => h.id === id))
    }, { timeout: 20_000 }).toBe(true)
    expect(await annotationPut, 'the drawn highlight is not written back').toBe(false)
    await other.close()
    await context.close()
  })

  // #1232: a tab still open while the reader read on in another browser: its next page turn is written (on their
  // revision) and their newer place is offered, the tab never moved by itself; Go moves it there.
  test('readV2Sync_AnotherBrowserReadOn_ThisTabTurnsAPage_WrittenAndTheirPlaceOffered_GoMovesThere', async ({ browser }) => {
    const who = email('v2newer')
    const context = await v2Context(browser, who)
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    const statePath = `/me/v2/books/${bookId}/reading-state`
    const isStatePut = (r: { method(): string; url(): string }) => r.method() === 'PUT' && r.url().endsWith(statePath)
    const serverPlace = async () =>
      ((await (await context.request.get(`${API_URL}${statePath}`, { headers: API_HEADERS })).json()) as { currentLocator: unknown }).currentLocator
    const turn = async (p: Page) => {
      const before = await status(p).textContent()
      const saved = p.waitForResponse((r) => isStatePut(r.request()) && r.ok())
      await clickBar(p, 'Next ›')
      await expect(status(p)).not.toHaveText(before ?? '')
      return (await saved).request().postDataJSON() as { currentLocator: unknown }
    }
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)

    // Tab A reads two pages (saved).
    await turn(page)
    await turn(page)

    // Another browser, same account, opens at A's place and reads on (saved, recorded later).
    const other = await v2Context(browser, who)
    const second = await other.newPage()
    await second.goto(`/en/library/my/${bookId}/read-v2`)
    await expect(second.getByTestId('v2-heading')).toHaveText('E2E V2 sync', { timeout: 20_000 })
    await expect(status(second)).toHaveText((await status(page).textContent()) ?? '', { timeout: 15_000 })
    for (let i = 0; i < 3; i++) await turn(second)
    const theirStatus = (await status(second).textContent()) ?? ''
    await other.close()

    // Tab A (never hidden) turns a page: its write loses on the revision, is written again on theirs, and their
    // newer place is offered.
    const lost = page.waitForResponse((r) => isStatePut(r.request()) && r.status() === 409)
    const ours = await turn(page)
    expect((await lost).status()).toBe(409)
    expect(await serverPlace()).toEqual(ours.currentLocator)
    const bar = page.getByRole('status', { name: 'Newer reading place' })
    await expect(bar).toBeVisible()

    // Keyboard reachable: Go is a real button. The page lands on their place and saves it (the reader's choice).
    const landed = page.waitForResponse((r) => isStatePut(r.request()) && r.ok())
    await bar.getByRole('button', { name: 'Go to their place' }).focus()
    await page.keyboard.press('Enter')
    await expect(bar).toHaveCount(0)
    await expect(status(page)).toHaveText(theirStatus)
    const there = (await landed).request().postDataJSON() as { currentLocator: unknown }
    expect(await serverPlace()).toEqual(there.currentLocator)
    await context.close()
  })

  // #1286: a page turn and, inside the page's 400 ms save debounce, a reload or an in-app link away: the server holds
  // the new place (the host takes the page's last `store` from its flush() on pagehide and on unmount). Compared by
  // the saved locator, never the bottom bar's percent.
  test('readV2Sync_APageTurnThenAReloadOrALinkAwayWithinTheDebounce_TheServerHoldsTheNewPlace', async ({ browser }) => {
    const context = await v2Context(browser, email('v2last'))
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    const messages = await collectPageMessages(page)
    const statePath = `/me/v2/books/${bookId}/reading-state`
    const serverCfi = async () => {
      const r = await context.request.get(`${API_URL}${statePath}`, { headers: API_HEADERS })
      return r.ok() ? ((await r.json()) as { currentLocator: { value: unknown } }).currentLocator.value : null
    }
    const statePuts: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().endsWith(statePath)) statePuts.push(String((r.postDataJSON() as { currentLocator: { value: unknown } }).currentLocator.value))
    })
    /**
     * Turns a page and runs `act` (a reload, a link away) while that turn's `store` is still debounced (400 ms): less
     * than 350 ms after its relocate reached the host, by the page's own clock. Late (CI latency): the turn is saved
     * the usual way, so it is waited out and done again, up to 3 times. Returns the turn's place.
     */
    const turnThen = async (act: () => Promise<unknown>) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { relocate, store } = await messages()
        await clickBar(page, 'Next ›')
        const got = await page.waitForFunction(([r, s]) => {
          const w = (window as unknown as { __page: PageMessages }).__page
          const moved = w.relocate.slice(r).find((m) => m.moved)
          return moved ? { cfi: moved.cfi, at: moved.at, stores: w.store.length - s } : null
        }, [relocate.length, store.length] as const, { polling: 'raf' })
        const { cfi, at, stores } = (await got.jsonValue())!
        const age = await page.evaluate((t) => performance.now() - t, at)
        if (stores === 0 && age < 350) {
          await act()
          return cfi
        }
        console.log(`[#1286 e2e] attempt ${attempt}: ${Math.round(age)} ms after the relocate (${stores} stores): too late, again`)
        await settled(null)
      }
      throw new Error('three page turns in a row could not be followed within 350 ms: the debounce path was never exercised')
    }
    /**
     * Nothing of the open (or an earlier turn) left in flight: the next write is the turn's. `restored`: what the
     * last open must have restored (a fresh upload has no place, `'none'`); null: no open to wait for (a retried turn).
     */
    const settled = async (restored: string | null = 'restored') => {
      if (restored !== null) await expect.poll(async () => (await messages()).restored.at(-1)?.position, { timeout: 20_000 }).toBe(restored)
      await page.waitForTimeout(1_000)
      await expect(page.getByTestId('v2-not-saved')).toHaveCount(0)
    }

    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)
    await settled('none')

    // A reload: the keepalive write carries the turn.
    const reloaded = await turnThen(() => page.reload())
    await expect.poll(serverCfi, { timeout: 15_000 }).toBe(reloaded)
    await expect(page.getByTestId('v2-heading')).toHaveText('E2E V2 sync', { timeout: 20_000 })
    await settled()

    // A route change (the top bar's link to the library): the session's last pass writes it, once.
    const left = await turnThen(() => page.getByRole('link', { name: 'Back to the library' }).click())
    await expect(page).toHaveURL(/\/en\/library\/?$/)
    await expect.poll(serverCfi, { timeout: 15_000 }).toBe(left)
    await page.waitForTimeout(1_000)
    expect(statePuts.filter((c) => c === left), 'the turn is written once').toHaveLength(1)
    await context.close()
  })

  // #1267: every control on the reader has an accessible name and every drawer or popup is a dialog (axe, WCAG 2 A and
  // 2.1 A: names, roles, ARIA; colour contrast is not this check): the bars, the settings and contents drawers, a word
  // popup. The route is never indexed and has a title; the skip link takes focus past the bars to the book.
  test('readV2A11y_TheBarsDrawersAndAWordPopup_NoAxeViolations_SkipLinkToTheBook_Noindex', async ({ browser }) => {
    const context = await v2Context(browser, email('v2a11y'))
    await withTranslation(context)
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
    await expect(page).toHaveTitle(/v2-sync\.epub/)
    /** Each violation by rule and element, so a failure names what to fix. */
    const violations = async () => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag21a']).analyze()).violations
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' > ')).join(' | ')}`)

    await page.keyboard.press('Escape')
    await expect(page.locator('main.v2-reader')).toHaveAttribute('data-bars', 'shown')
    expect(await violations()).toEqual([])

    await clickBar(page, 'Reading settings')
    await expect(page.getByRole('dialog', { name: 'Reading settings' })).toBeVisible()
    expect(await violations()).toEqual([])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await clickBar(page, 'Contents')
    await expect(page.getByRole('dialog', { name: 'Contents' })).toBeVisible()
    expect(await violations()).toEqual([])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const width = page.viewportSize()!.width
    const word = (await firstParagraphWords(page)).find((w) => w.x > width * 0.35 && w.x < width * 0.65)
    expect(word, 'a word in the centre zone').toBeTruthy()
    await page.mouse.click(word!.x, word!.y)
    await expect(page.locator('.word-popup .word-popup__translation')).toHaveText('MOCK-TRANSLATION')
    expect(await violations()).toEqual([])
    await page.keyboard.press('Escape')
    await expect(page.locator('.word-popup')).toHaveCount(0)

    // The skip link: the first stop from the top of the document, then the book (the frame) has focus.
    await page.locator('main.v2-reader').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('link', { name: 'Skip to the book' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('iframe[title="Book text"]')).toBeFocused()
    await context.close()
  })

  // #1227: a load that fails says why; one that cannot be helped by trying again offers no Retry.
  test('a file the server no longer has: the "gone" alert, no Retry', async ({ browser }) => {
    const context = await v2Context(browser, email('v2r404'))
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.route('**/me/v2/books/*/files/*/content', (r) =>
      r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'file_not_found', message: 'gone' }) }))
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    const alert = page.getByTestId('v2-load-error')
    await expect(alert).toHaveText('This book or its file is no longer in your library.')
    await expect(alert.getByRole('button')).toHaveCount(0)
    await context.close()
  })

  test('a reader frame that never sends ready: the deadline alert after 30 s; Retry opens the book', async ({ browser }) => {
    const context = await v2Context(browser, email('v2rframe'))
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.route('**/reader-v2/frame.html*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>blocked</title>' }))
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('The reader failed to load', { timeout: 40_000 })
    await page.unroute('**/reader-v2/frame.html*')
    await alert.getByRole('button', { name: 'Retry' }).click()
    await expectOpened(page)
    await context.close()
  })
})
