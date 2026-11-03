import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { waitForReaderLoad } from '../helpers/reader'
import { testLogin } from '../helpers/api'

// @v2 — the web app on the V2 sync API (#1025 M2.7): with Features:V2Api on, an upload, the reader,
// its position, a highlight, a saved word and a delete all go through /me/v2. Skips when the probe
// answers 404 (the flag is off: every other run of this suite) unless V2_E2E=1. CI runs it blocking in a second,
// V2-on pass of the e2e job. Every wait is a poll on a real signal.
//
// Content: a 3-chapter EPUB fixture (50 paragraphs each), uploaded by a fresh user each run, so the
// sha256 lookup never finds an earlier copy. The worker extracts its chapters (the transitional reader).

const API_URL = process.env.API_URL ?? 'http://localhost:8080'
const API_HEADERS = { Host: 'general.localhost' }
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, '../fixtures/v2-sync.epub')
const TITLE = 'v2-sync' // the file name: V2 imports take it as the title

const article = (page: Page) => page.locator('.reader-section__article')
const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY))
// In-app navigation is a pushState, so waitForURL (which waits for `load`) never resolves.
const atChapter = (key: string) => new RegExp(`/read/${key}/?(\\?|#|$)`)

async function v2Get<T>(request: APIRequestContext, route: string): Promise<T | null> {
  const resp = await request.get(`${API_URL}/me/v2${route}`, { headers: API_HEADERS })
  return resp.ok() ? ((await resp.json()) as T) : null
}

/** Select `text` inside the first paragraph that contains it and let the reader see the selection. */
async function select(page: Page, text: string) {
  const found = await article(page).evaluate((root, wanted) => {
    const p = Array.from(root.querySelectorAll('p')).find((el) => el.textContent?.includes(wanted))
    const node = p?.firstChild
    if (!p || !node?.textContent) return false
    p.scrollIntoView({ block: 'center' })
    const start = node.textContent.indexOf(wanted)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + wanted.length)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return true
  }, text)
  expect(found, `"${text}" is on the page`).toBe(true)
}

test.describe('V2 sync @v2', () => {
  test.describe.configure({ timeout: 180_000 })

  test('upload, read, resume, highlight, save a word and delete, all on /me/v2', async ({ browser }) => {
    const context = await browser.newContext()
    const request = context.request
    const email = `e2e-v2-${Date.now()}-${test.info().repeatEachIndex}@textstack.app`
    await testLogin(request, email)
    const status = await request.get(`${API_URL}/me/v2/status`, { headers: API_HEADERS })
    // V2_E2E=1 (CI's V2 pass): a 404 fails instead of skipping, so that pass cannot go green untested.
    test.skip(status.status() === 404 && process.env.V2_E2E !== '1', 'Features:V2Api is off: /me/v2 is not mapped')
    expect(status.ok(), `GET /me/v2/status: ${status.status()}`).toBeTruthy()
    await context.addInitScript(() => {
      localStorage.setItem('textstack_native_language', 'en')
      localStorage.setItem('reader.onboarding.seen', '1')
    })
    const page = await context.newPage()

    // Upload: sha256, import, parts, complete — then Processing until the worker has the chapters.
    await page.goto('/en/library')
    await page.getByRole('button', { name: 'Upload book' }).click()
    const imported = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/me\/v2\/books\/[0-9a-f-]{36}$/.test(r.url()))
    await page.locator('.upload-modal input[type="file"]').setInputFiles(FIXTURE)
    const importResp = await imported
    expect(importResp.status(), `import: ${await importResp.text()}`).toBe(201)
    const { id: bookId, currentFile } = (await importResp.json()) as { id: string; currentFile: { id: string } }
    await expect(page.getByRole('button', { name: 'Read now' })).toBeVisible({ timeout: 120_000 })

    const toc = await v2Get<{ items: { chapterKey: string }[] }>(request, `/books/${bookId}/files/${currentFile.id}/chapters`)
    const keys = toc!.items.map((c) => c.chapterKey)
    expect(keys).toHaveLength(3)

    // The library is the V2 feed.
    await page.goto('/en/library')
    await expect(page.locator(`[data-book-id="${bookId}"]`)).toContainText(TITLE, { timeout: 15_000 })

    // Open, then navigate to the next chapter.
    await page.goto(`/en/library/my/${bookId}/read/${keys[0]}`)
    await waitForReaderLoad(page)
    await expect(article(page)).toContainText('The Pond, paragraph 1.', { timeout: 15_000 })
    await page.locator('.reader-nav__btn--next').dispatchEvent('click')
    await expect(page).toHaveURL(atChapter(keys[1]))
    await expect(article(page)).toContainText('The Woods, paragraph 1.')

    // Read to the middle once the open has been saved (a scroll before the restore is undone by it):
    // the reader's own TextPosition lands on the server as textstack-position-v1.
    await expect.poll(() => page.evaluate((id) => JSON.parse(localStorage.getItem(`userbook.progress.${id}`) ?? 'null')?.chapterSlug, bookId),
      { timeout: 15_000 }).toBe(keys[1])
    const target = await page.evaluate(() => {
      const y = Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2)
      window.scrollTo({ top: y, behavior: 'instant' })
      return y
    })
    expect(target, 'the fixture chapter scrolls').toBeGreaterThan(1000)
    type State = { currentLocator: { scheme: string; value: { chapterSlug: string; anchor?: { exact: string }; chapterFraction: number } } }
    await expect.poll(async () => {
      const state = await v2Get<State>(request, `/books/${bookId}/reading-state`)
      const value = state?.currentLocator.value
      return state?.currentLocator.scheme === 'textstack-position-v1' && value?.chapterSlug === keys[1]
        && !!value.anchor && value.chapterFraction > 0.2
    }, { timeout: 20_000 }).toBe(true)

    // Reopen with this device's record gone: the place comes from the server alone.
    await page.evaluate((id) => localStorage.removeItem(`userbook.progress.${id}`), bookId)
    await page.close()
    const reader = await context.newPage()
    await reader.goto(`/en/library/my/${bookId}/read/${keys[1]}`)
    await waitForReaderLoad(reader)
    await expect(article(reader)).toContainText('The Woods, paragraph 1.', { timeout: 15_000 })
    await expect.poll(async () => Math.abs((await scrollY(reader)) - target), { timeout: 15_000 }).toBeLessThanOrEqual(80)

    // A highlight: its own uuid, a textstack-anchor-v1 locator naming this chapter.
    const phrase = 'The Woods, paragraph 30.'
    await select(reader, phrase)
    const put = reader.waitForResponse((r) => r.request().method() === 'PUT' && /\/me\/v2\/annotations\/[0-9a-f-]{36}$/.test(r.url()))
    await reader.getByRole('button', { name: 'Highlight yellow' }).click()
    const annotation = await put
    expect(annotation.status(), `PUT annotation: ${await annotation.text()}`).toBe(201)
    const sent = annotation.request().postDataJSON() as { locator: { scheme: string; value: { chapterKey: string; exact: string } } }
    expect(sent.locator).toMatchObject({ scheme: 'textstack-anchor-v1', value: { chapterKey: keys[1], exact: phrase } })
    const { id: highlightId } = (await annotation.json()) as { id: string }
    const painted = (p: Page) => p.locator(`[data-group="highlight"][data-id="${highlightId}"]:not([data-dot])`)
    await expect(painted(reader).first()).toBeAttached({ timeout: 10_000 })

    await reader.reload()
    await waitForReaderLoad(reader)
    await expect(painted(reader).first()).toBeAttached({ timeout: 15_000 })

    // A word: tapping it saves the card, its sentence an example on this book.
    const saved = reader.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith('/me/v2/vocabulary/words'))
    await select(reader, 'deliberately')
    const word = await saved
    expect(word.ok(), `PUT word: ${word.status()} ${await word.text()}`).toBeTruthy()
    expect(word.request().postDataJSON()).toMatchObject({ word: 'deliberately', example: { bookId } })
    await reader.goto('/en/vocabulary')
    await expect(reader.getByText('deliberately', { exact: true }).first()).toBeVisible({ timeout: 15_000 })

    // Delete: the card goes, the feed keeps the book as removed.
    await reader.goto('/en/library')
    const row = reader.locator(`[data-book-id="${bookId}"]`)
    await row.getByRole('button', { name: 'Options' }).click()
    await reader.getByRole('menuitem', { name: 'Delete' }).click()
    await reader.locator('.confirm-delete-modal__btn--danger').click()
    await expect(row).toHaveCount(0, { timeout: 15_000 })
    const library = await v2Get<{ items: { id: string; removedAt: string | null }[] }>(request, '/library/changes')
    expect(library!.items.find((b) => b.id === bookId)?.removedAt).toBeTruthy()

    await context.close()
  })
})
