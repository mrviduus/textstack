import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect, type Page } from '@playwright/test'
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

test.describe('V2 reader page @v2', () => {
  test.describe.configure({ timeout: 120_000 })

  test('a V2 upload opens from its book page, turns a page, and opens again after a reload', async ({ browser }) => {
    const context = await browser.newContext()
    const request = context.request
    await testLogin(request, `e2e-v2r-${Date.now()}-${test.info().repeatEachIndex}@textstack.app`)
    const probe = await request.get(`${API_URL}/me/v2/status`, { headers: API_HEADERS })
    test.skip(probe.status() === 404 && process.env.V2_E2E !== '1', 'Features:V2Api is off: /me/v2 is not mapped')
    expect(probe.ok(), `GET /me/v2/status: ${probe.status()}`).toBeTruthy()
    const page = await context.newPage()

    // Upload on V2 (sha256, import, parts, complete); the bytes are readable once the content is complete.
    await page.goto('/en/library')
    await page.getByRole('button', { name: 'Upload book' }).click()
    const imported = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/me\/v2\/books\/[0-9a-f-]{36}$/.test(r.url()))
    const completed = page.waitForResponse((r) => r.request().method() === 'POST' && /\/me\/v2\/books\/[0-9a-f-]{36}\/files\/[0-9a-f-]{36}\/content$/.test(r.url()))
    await page.locator('.upload-modal input[type="file"]').setInputFiles(FIXTURE)
    const { id: bookId } = (await (await imported).json()) as { id: string }
    expect((await completed).ok()).toBeTruthy()

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
    expect(shell.headers()['cache-control']).toBe('no-store')
    const src = (await shell.text()).match(/src="(\/reader-v2\/page\.[0-9a-f]{16}\.js)"/)?.[1]
    expect(src, 'the shell loads the page script').toBeTruthy()
    expect((await request.head(src!)).headers()['cache-control']).toContain('immutable')

    await page.reload()
    await expectOpened(page)
    await context.close()
  })
})
