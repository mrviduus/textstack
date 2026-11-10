import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect, type Page } from '@playwright/test'

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
  await expect(status(page)).toContainText('section')
}

test.describe('V2 reader dev route @v2-reader-dev', () => {
  // The cheap first gate; the probe below covers any other server without the route (e.g. a local preview).
  test.skip(!!process.env.CI, 'dev server only: CI serves the production build, which has no /dev route')

  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/reader-v2')
    const served = await page.getByLabel('Pick EPUB').waitFor({ timeout: 10_000 }).then(() => true, () => false)
    test.skip(!served, 'this server does not serve /dev/reader-v2: run the suite against the dev server (pnpm dev)')
  })

  test('a picked EPUB renders its first section', async ({ page }) => {
    await openFixture(page)
    await expect.poll(() => sectionText(page)).toContain(FIRST_SECTION_TEXT)
  })

  test('Next turns the page', async ({ page }) => {
    await openFixture(page)
    const before = await status(page).textContent()
    await page.getByRole('button', { name: 'Next ›' }).click()
    await expect(status(page)).not.toHaveText(before ?? '')
  })

  test('after a reload, reopening the file restores the position from localStorage', async ({ page }) => {
    await openFixture(page)
    const start = await status(page).textContent()
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Next ›' }).click()
    // The page saves only after a turn, debounced; whatever it saved last is what a reopen must restore.
    await expect.poll(() => storedPosition(page)).not.toBeNull()

    await page.reload()
    const position = (await storedPosition(page))!
    await openFixture(page)
    await expect(page.getByTestId('v2-restore')).toHaveText('restore: restored')
    await expect(status(page)).toHaveText(new RegExp(`^${Math.round(position.fraction * 100)}% · section ${position.index + 1}/3`))
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
