import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { testLogin } from '../helpers/api'

// @v2 — the V2 reader page on its production route (#1225): /:lang/library/my/:id/read-v2, behind
// Features:V2Api. A V2 upload's file bytes come from /me/v2/books/{id}/files/{fileId}/content into the
// frame (/reader-v2/frame.html: a no-store shell + the content-hashed page script). Skips when the probe
// answers 404 (flag off) unless V2_E2E=1, as v2-sync.spec.ts. In CI it runs on the production build
// (`vite preview`, which serves the frame through the same handler as nginx's files).

const API_URL = process.env.API_URL ?? 'http://localhost:8080'
const API_HEADERS = { Host: 'general.localhost' }
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, '../fixtures/v2-sync.epub')
const FIRST_SECTION_TEXT = 'The Pond, paragraph 1.'

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

/** A signed-in context for `email`; skipped when V2 is off (unless V2_E2E=1). */
async function v2Context(browser: { newContext(): Promise<BrowserContext> }, email: string, answerBanner = true) {
  const context = await browser.newContext()
  // Answered, so the cookie banner is out of the way; #1292's spec leaves it up.
  if (answerBanner) await context.addInitScript(() => localStorage.setItem('cookieConsent', 'rejected'))
  await testLogin(context.request, email)
  const probe = await context.request.get(`${API_URL}/me/v2/status`, { headers: API_HEADERS })
  test.skip(probe.status() === 404 && process.env.V2_E2E !== '1', 'Features:V2Api is off: /me/v2 is not mapped')
  expect(probe.ok(), `GET /me/v2/status: ${probe.status()}`).toBeTruthy()
  return context
}

/** Upload on V2 (sha256, import, parts, complete); the bytes are readable once the content is complete. */
async function uploadFixture(page: Page): Promise<string> {
  await page.goto('/en/library')
  await page.locator('.site-header__upload-btn').click()
  const imported = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/me\/v2\/books\/[0-9a-f-]{36}$/.test(r.url()))
  const completed = page.waitForResponse((r) => r.request().method() === 'POST' && /\/me\/v2\/books\/[0-9a-f-]{36}\/files\/[0-9a-f-]{36}\/content$/.test(r.url()))
  await page.locator('.upload-modal input[type="file"]').setInputFiles(FIXTURE)
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
}

/** The page's `restored`, `store` and `highlights` messages, as the host's window receives them (the host shows neither here). */
async function collectPageMessages(page: Page) {
  await page.addInitScript(() => {
    if (window.top !== window) return
    const w = window as unknown as { __page: Record<string, unknown[]> }
    w.__page = { restored: [], store: [], highlights: [] }
    addEventListener('message', (e) => {
      try {
        const m = typeof e.data === 'string' ? JSON.parse(e.data) : null
        if (m?.type === 'restored' || m?.type === 'store' || m?.type === 'highlights') w.__page[m.type].push(m)
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
    const box = await (await f.frameElement()).boundingBox().catch(() => null)
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

    // The entry point: the book page's secondary link, V2 only.
    await page.goto(`/en/library/my/${bookId}`)
    await page.getByRole('link', { name: 'Open in the V2 reader' }).click()
    await expect(page).toHaveURL(new RegExp(`/en/library/my/${bookId}/read-v2/?$`))
    await expect(page.locator('iframe[title="V2 reader"]')).toHaveAttribute('src', '/reader-v2/frame.html')
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

  // #1263: the bars hide while reading; keys and an edge tap turn the page; a tap off any word toggles the bars.
  test('readV2Chrome_TextAndEdgeTapsKeysAndTheBarsNext_TurnAndToggleAsTheyShould', async ({ browser }) => {
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

    // A tap off any word in the centre toggles the bars (a blank point of the book: between paragraphs, the spread's
    // column gap; never under the shown bars); a word on an edge turns (a word in the centre opens its popup, #1269:
    // the word popup spec below); focus stays in the book.
    const frames = page.frames().filter((f) => f.url().startsWith('blob:'))
    const texts = await Promise.all(frames.map((f) => f.evaluate(() => document.body?.innerText ?? '').catch(() => '')))
    const section = frames[texts.findIndex((t) => t.includes(FIRST_SECTION_TEXT))]
    const a = (await section.locator('p').nth(0).boundingBox())!
    const width = page.viewportSize()!.width
    const line = a.y + 12
    const blank = await blankCentrePoint(page)
    await page.mouse.click(blank.x, blank.y)
    await expect(main).toHaveAttribute('data-bars', 'shown')
    await page.mouse.click(blank.x, blank.y)
    await expect(main).toHaveAttribute('data-bars', 'hidden')
    await page.mouse.click(width - a.x - 30, line)
    await expect(status(page)).not.toHaveText(first)
    await page.mouse.click(a.x + 15, line)
    await expect(status(page)).toHaveText(first)

    // Keys with focus inside the book: the page forwards them (`key`).
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME')
    await page.keyboard.press('ArrowRight')
    await expect(status(page)).not.toHaveText(first)
    await page.keyboard.press('Escape')
    await expect(main).toHaveAttribute('data-bars', 'shown')

    // The very edges (the page's own margin): left back, right on; a turn hides the bars.
    await page.mouse.click(10, line)
    await expect(status(page)).toHaveText(first)
    await expect(main).toHaveAttribute('data-bars', 'hidden')
    await page.mouse.click(width - 10, line)
    await expect(status(page)).not.toHaveText(first)
    // A key after a click in the page's margin: forwarded from the page's own document.
    const turned = (await status(page).textContent()) ?? ''
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
  // language into the reader's, with the sentence; the bars and the place stay; its close closes it.
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
    expect(asked.at(-1)).toMatchObject({ text: word!.word, sourceLang: 'en', targetLang: 'uk', sentence: expect.stringContaining('The Pond, paragraph 1.') })
    await expect(main).toHaveAttribute('data-bars', 'hidden')
    await expect(status(page)).toHaveText(before)

    await popup.getByRole('button', { name: 'Close' }).first().click()
    await expect(popup).toHaveCount(0)
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
    await expect(toolbar.getByRole('button', { name: 'Listen to pronunciation' })).toHaveCount(0)

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
  // neighbouring entries by title.
  test('readV2Toc_AnEntryChosenThenThePreviousSection_TheBookJumpsAndTheCurrentEntryFollows', async ({ browser }) => {
    const context = await v2Context(browser, email('v2toc'))
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    await page.goto(`/en/library/my/${bookId}/read-v2`)
    await expectOpened(page)

    await clickBar(page, 'Contents')
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
