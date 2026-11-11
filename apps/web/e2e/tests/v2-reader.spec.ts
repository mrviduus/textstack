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
  await page.getByRole('button', { name: 'Upload book' }).click()
  const imported = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/me\/v2\/books\/[0-9a-f-]{36}$/.test(r.url()))
  const completed = page.waitForResponse((r) => r.request().method() === 'POST' && /\/me\/v2\/books\/[0-9a-f-]{36}\/files\/[0-9a-f-]{36}\/content$/.test(r.url()))
  await page.locator('.upload-modal input[type="file"]').setInputFiles(FIXTURE)
  const { id } = (await (await imported).json()) as { id: string }
  expect((await completed).ok()).toBeTruthy()
  return id
}

/** The page's `restored` answers, as the host's window receives them (the host shows none on this route). */
async function collectRestored(page: Page) {
  await page.addInitScript(() => {
    if (window.top !== window) return
    const w = window as unknown as { __restored: unknown[] }
    w.__restored = []
    addEventListener('message', (e) => {
      try {
        const m = typeof e.data === 'string' ? JSON.parse(e.data) : null
        if (m?.type === 'restored') w.__restored.push(m)
      } catch { /* not the page's */ }
    })
  })
  return () => page.evaluate(() => (window as unknown as { __restored: { position: string; highlights: { id: string; status: string }[] }[] }).__restored)
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
  test('the place survives a reload, and a highlight is seen from a second browser context', async ({ browser }) => {
    const who = email('v2rs')
    const context = await v2Context(browser, who)
    const page = await context.newPage()
    const bookId = await uploadFixture(page)
    const restored = await collectRestored(page)
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
    await expect.poll(async () => (await restored()).at(-1)?.position, { timeout: 15_000 }).toBe('restored')
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

    // Another browser, same account: the highlight comes back from the server and is drawn.
    const other = await v2Context(browser, who)
    const second = await other.newPage()
    const restoredThere = await collectRestored(second)
    await second.goto(`/en/library/my/${bookId}/read-v2`)
    await expect.poll(async () => (await restoredThere()).at(-1)?.highlights ?? [], { timeout: 20_000 }).toContainEqual({ id, status: 'restored' })
    await other.close()
    await context.close()
  })
})
