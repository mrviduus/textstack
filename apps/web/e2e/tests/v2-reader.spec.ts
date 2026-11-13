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
  await expect(status(page)).toContainText('section')
  await expect(page.getByRole('alert')).toHaveCount(0)
}

/** A signed-in context for `email`; skipped when V2 is off (unless V2_E2E=1). */
async function v2Context(browser: { newContext(): Promise<BrowserContext> }, email: string) {
  const context = await browser.newContext()
  // The cookie banner sits over the reader's bottom bar (Prev / Next) until it is answered.
  await context.addInitScript(() => localStorage.setItem('cookieConsent', 'rejected'))
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
    const place = await status(page).textContent()

    await clickBar(page, 'Reading settings')
    const panel = page.getByTestId('v2-settings')
    await panel.getByRole('button', { name: 'Dark' }).click()
    await panel.getByRole('button', { name: 'Larger text' }).click()
    await expect(panel.getByTestId('v2-font-size')).toHaveText('22px')
    await expect.poll(look).toBe('22px rgb(26, 26, 26)')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('.reader-top-bar')).toHaveCSS('color', 'rgb(224, 224, 224)')
    await expect(status(page)).toHaveText(place ?? '')
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

    // Taps on the text (a word acts as a tap at its centre until the word popup, #1269): the centre toggles the
    // bars, an edge turns; focus stays in the book.
    const frames = page.frames().filter((f) => f.url().startsWith('blob:'))
    const texts = await Promise.all(frames.map((f) => f.evaluate(() => document.body?.innerText ?? '').catch(() => '')))
    const section = frames[texts.findIndex((t) => t.includes(FIRST_SECTION_TEXT))]
    const a = (await section.locator('p').nth(0).boundingBox())!
    const width = page.viewportSize()!.width
    const line = a.y + 12
    await page.mouse.click(width / 2 - 200, line)
    await expect(main).toHaveAttribute('data-bars', 'shown')
    await page.mouse.click(width / 2 - 200, line)
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

  // #1226: position and highlights on /me/v2 through the shared client, not in this browser's storage.
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
