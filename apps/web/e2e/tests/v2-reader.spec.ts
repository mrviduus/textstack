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

async function expectOpened(page: Page) {
  await expect(page.getByTestId('v2-heading')).toHaveText('E2E V2 sync', { timeout: 20_000 })
  await expect.poll(() => sectionText(page), { timeout: 15_000 }).toContain(FIRST_SECTION_TEXT)
  await expect(status(page)).toContainText('section')
  await expect(page.getByRole('alert')).toHaveCount(0)
}

/** A signed-in context for `email`; skipped when V2 is off (unless V2_E2E=1). */
async function v2Context(browser: { newContext(): Promise<BrowserContext> }, email: string) {
  const context = await browser.newContext()
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
    await page.getByRole('button', { name: 'Next ›' }).click()
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
    await page.getByRole('button', { name: 'Next ›' }).click()
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
    await page.getByRole('button', { name: 'Highlight', exact: true }).click()
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
      await second.getByRole('button', { name: 'Next ›' }).click()
      return (await there()).store.some((m) => (JSON.parse(m.json).highlights as { id: string }[]).some((h) => h.id === id))
    }, { timeout: 20_000 }).toBe(true)
    expect(await annotationPut, 'the drawn highlight is not written back').toBe(false)
    await other.close()
    await context.close()
  })
})
