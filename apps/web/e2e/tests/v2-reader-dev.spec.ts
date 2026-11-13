import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect, type Page } from '@playwright/test'
import { V2_READER_FRAME_PATH } from '../../../mobile/src/lib/v2reader/framePath.mjs'

// @v2-reader-dev — the V2 reader page on the web dev route (R5, #1037): /dev/reader-v2 hosts the
// foliate page in an iframe, the EPUB comes from a file input, everything persists in localStorage.
// The route exists on the dev server only (`pnpm dev`, the local webServer); the production build (CI,
// `pnpm preview`) must not have it, so the suite skips wherever the route is not served.
//
// Content: the 3-chapter v2-sync fixture (50 paragraphs per chapter), so a chapter spans many pages.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, '../fixtures/v2-sync.epub')
const FIRST_SECTION_TEXT = 'The Pond, paragraph 1.'

const status = (page: Page) => page.getByTestId('v2-status')
/** The bar's Next: the bars hide while reading (#1263), Esc shows them. */
async function next(page: Page) {
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Next ›' }).click()
}
const pick = (page: Page) => page.getByLabel('Pick EPUB').setInputFiles(FIXTURE)
const library = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('v2reader:library') ?? '{"books":[]}').books as unknown[])
/** The position the page last sent in `store`, as the host kept it. */
const storedPosition = (page: Page) =>
  page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('v2reader:store:'))
    return key ? (JSON.parse(localStorage.getItem(key)!).position as { fraction: number; index: number } | null) : null
  })

/** The text of every section frame foliate has loaded (its frames sit in a closed shadow root). */
const sectionText = (page: Page) =>
  Promise.all(page.frames().filter((f) => f.url().startsWith('blob:')).map((f) => f.evaluate(() => document.body?.innerText ?? '')))
    .then((texts) => texts.join('\n'))

async function openFixture(page: Page) {
  await pick(page)
  await expect(page.getByTestId('v2-heading')).toHaveText('E2E V2 sync')
  // The percent read, then the current contents entry's title (#1261): never a section number.
  await expect(status(page)).toHaveText(/^\d+% · The (Pond|Woods|Village)$/)
}

test.describe('V2 reader dev route @v2-reader-dev', () => {
  // The cheap first gate; the probe below covers any other server without the route (e.g. a local preview).
  test.skip(!!process.env.CI, 'dev server only: CI serves the production build, which has no /dev route')

  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/reader-v2')
    const served = await page.getByLabel('Pick EPUB').waitFor({ timeout: 10_000 }).then(() => true, () => false)
    test.skip(!served, 'this server does not serve /dev/reader-v2: run the suite against the dev server (pnpm dev)')
  })

  // #1219: the page is its own same-origin document (not srcdoc, which inherits the app CSP), with a nonce
  // per response and its own frame-ancestors.
  test('the reader frame is a src document with a fresh nonce per response', async ({ page }) => {
    await expect(page.locator('iframe[title="V2 reader"]')).toHaveAttribute('src', V2_READER_FRAME_PATH)
    await expect(page.locator('iframe[title="V2 reader"]')).not.toHaveAttribute('srcdoc', /./)
    const load = () => page.request.get(V2_READER_FRAME_PATH)
    const [a, b] = [await load(), await load()]
    expect(a.headers()['content-security-policy']).toBe("frame-ancestors 'self'")
    const nonce = async (r: typeof a) => (await r.text()).match(/script-src 'nonce-([0-9a-f]{32})'/)?.[1]
    const [na, nb] = [await nonce(a), await nonce(b)]
    expect(na).toBeTruthy()
    expect(na).not.toBe(nb)
  })

  // #1080 item 3 (web), #1227: a frame that is not the page (here a 404) never sends ready; the host says so,
  // and Retry loads a fresh frame, which opens the book picked meanwhile (its bytes never left the host).
  test('a frame that never becomes ready shows an error; Retry loads a fresh frame', async ({ page }) => {
    await page.route(`**${V2_READER_FRAME_PATH}*`, (r) => r.fulfill({ status: 404, body: 'not found' }))
    await page.goto('/dev/reader-v2')
    await expect(page.getByLabel('Pick EPUB')).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await pick(page)
    await expect(page.getByTestId('v2-heading')).toHaveText('Opening v2-sync.epub')
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('The reader failed to load', { timeout: 15_000 })
    await page.unroute(`**${V2_READER_FRAME_PATH}*`)
    await alert.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByTestId('v2-heading')).toHaveText('E2E V2 sync')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a picked EPUB renders its first section', async ({ page }) => {
    await openFixture(page)
    await expect.poll(() => sectionText(page)).toContain(FIRST_SECTION_TEXT)
  })

  test('Next turns the page', async ({ page }) => {
    await openFixture(page)
    const before = await status(page).textContent()
    await next(page)
    await expect(status(page)).not.toHaveText(before ?? '')
  })

  // #1168: the still-open book relocates during the new pick's file read; neither those nor the dying
  // view's teardown events may leave the previous book's position standing beside the failure.
  test('a failed open after a book shows no position of the previous book', async ({ page }) => {
    await openFixture(page)
    const before = await status(page).textContent()
    await next(page)
    await expect(status(page)).not.toHaveText(before ?? '')
    await page.getByLabel('Pick EPUB').setInputFiles({ name: 'broken.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('not a zip') })
    await expect(page.getByRole('alert')).toContainText('cannot open broken.epub')
    await expect(status(page)).toHaveText('')
    // #1080 item 6: nor its title (the alert names the file that failed).
    await expect(page.getByTestId('v2-heading')).not.toHaveText('E2E V2 sync')
  })

  test('after a reload, reopening the file restores the position from localStorage', async ({ page }) => {
    await openFixture(page)
    const start = await status(page).textContent()
    for (let i = 0; i < 3; i++) await next(page)
    // The page saves only after a turn, debounced; whatever it saved last is what a reopen must restore.
    await expect.poll(() => storedPosition(page)).not.toBeNull()

    await page.reload()
    const position = (await storedPosition(page))!
    await openFixture(page)
    await expect(page.getByTestId('v2-restore')).toHaveText('restore: restored')
    await expect(status(page)).toHaveText(`${Math.round(position.fraction * 100)}% · ${['The Pond', 'The Woods', 'The Village'][position.index]}`)
    await expect(status(page)).not.toHaveText(start ?? '')
  })

  test('identical bytes picked again reuse the library entry', async ({ page }) => {
    await openFixture(page)
    await page.reload()
    await openFixture(page)
    expect(await library(page)).toHaveLength(1)
    await expect(page.getByTestId('v2-library').getByRole('listitem')).toHaveCount(1)
  })
})
