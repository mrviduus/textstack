import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

// @reader-pdf — the Original-layout PDF reader (ADR-012), flag off and on (ADR-025 Phase 5 slice 5).
// CI runs it twice: the default build (PdfOriginalView) and a VITE_READER_ENGINE_PDF=true build
// (PdfEngineView). Every wait is a poll on a real signal, never a sleep.
//
// Content: each test's own user uploads the engine's 40-page fixture (page numbers in the footer).
// Original layout needs only the stored file (hasOriginalPdf = the upload's format), never the
// worker, so the test opens the chapterless route straight after the upload.

const API_URL = process.env.API_URL ?? 'http://localhost:8080'
const API_HEADERS = { Host: 'general.localhost' }
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, '../../../../packages/reader-engine/playground/pdf/fixture.pdf')
const TITLE = 'E2E reader PDF fixture'
const PAGES = 40

const ENGINE_ON = process.env.VITE_READER_ENGINE_PDF === 'true'

const openContexts: BrowserContext[] = []

/** A signed-in page for a user only this test uses, with the fixture uploaded and its state reset. */
async function pdfReaderPage(browser: Browser, name: string): Promise<{ page: Page; bookId: string }> {
  const email = `e2e-reader-pdf-${name}-${test.info().repeatEachIndex}@textstack.app`
  const context = await browser.newContext()
  openContexts.push(context)
  const request = context.request
  const login = await request.post(`${API_URL}/auth/test-login`, { data: { email }, headers: API_HEADERS })
  expect(login.ok(), `test-login ${email}: ${login.status()}`).toBeTruthy()

  // Reuse this user's upload from an earlier run; upload only when there is none.
  const list = await request.get(`${API_URL}/me/books`, { headers: API_HEADERS })
  expect(list.ok(), `GET /me/books: ${list.status()}`).toBeTruthy()
  let bookId = ((await list.json()) as { id: string; title: string }[]).find((b) => b.title === TITLE)?.id
  if (!bookId) {
    const up = await request.post(`${API_URL}/me/books/upload`, {
      headers: API_HEADERS,
      multipart: {
        file: { name: 'reader-pdf-fixture.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(FIXTURE) },
        title: TITLE,
      },
    })
    expect(up.ok(), `upload: ${up.status()} ${await up.text()}`).toBeTruthy()
    const body = (await up.json()) as { userBookId: string; hasOriginalPdf: boolean }
    expect(body.hasOriginalPdf).toBe(true)
    bookId = body.userBookId
  }

  // Start at page 1 with no highlights, so a retry or a second run cannot pass on old state.
  const reset = await request.put(`${API_URL}/me/books/${bookId}/progress`, {
    headers: API_HEADERS,
    data: { chapterSlug: null, locator: 'page:1', percent: 1 / PAGES, percentUnit: 'book', locatorKind: 'page', updatedAt: new Date().toISOString() },
  })
  expect(reset.ok(), `reset progress: ${reset.status()}`).toBeTruthy()
  const hls = await request.get(`${API_URL}/me/highlights/userbook/${bookId}`, { headers: API_HEADERS })
  if (hls.ok()) {
    for (const h of (await hls.json()) as { id: string }[]) {
      await request.delete(`${API_URL}/me/highlights/${h.id}`, { headers: API_HEADERS })
    }
  }

  await context.addInitScript(() => {
    localStorage.setItem('textstack_native_language', 'en')
    localStorage.setItem('reader.onboarding.seen', '1')
  })
  return { page: await context.newPage(), bookId }
}

const pageEl = (page: Page, n: number) => page.locator(`.pdf-page[data-page="${n}"]`)
const pageInput = (page: Page) => page.getByRole('textbox', { name: 'Go to page' })

/** Open the chapterless Original route and wait until page `n` has a drawn canvas. */
async function openPdf(page: Page, bookId: string, n = 1) {
  await page.goto(`/en/library/my/${bookId}/read`)
  // The build really is the one this run claims: a flag that never reached vite would pass as "engine on".
  await expect(page.locator(ENGINE_ON ? '.pdf-engine' : '.pdf-original')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.pdf-original__page-count')).toHaveText(`/ ${PAGES}`, { timeout: 30_000 })
  await expect(pageInput(page)).toHaveAttribute('placeholder', String(n), { timeout: 15_000 })
  await expect.poll(() => pageEl(page, n).locator('canvas').evaluate((c: HTMLCanvasElement) => c.width).catch(() => 0), { timeout: 15_000 })
    .toBeGreaterThan(0)
  await expect(pageEl(page, n).locator('.textLayer')).toContainText(`Page ${n}`)
}

/** Page `n` covers the middle of the screen: the jump landed there, not just a counter. */
const pageCoversMiddle = (page: Page, n: number) =>
  pageEl(page, n).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return r.top <= window.innerHeight / 2 && r.bottom >= window.innerHeight / 2
  })

async function jumpTo(page: Page, n: number) {
  await pageInput(page).fill(String(n))
  await pageInput(page).press('Enter')
  await expect(pageInput(page)).toHaveAttribute('placeholder', String(n), { timeout: 10_000 })
  await expect.poll(() => pageCoversMiddle(page, n), { timeout: 10_000 }).toBe(true)
}

/** Either viewer's painted rects of one highlight: the old layer's, or the engine's fill (not its dot). */
const painted = (page: Page, id: string) =>
  page.locator(`[data-highlight-id="${id}"], [data-group="highlight"][data-id="${id}"]:not([data-dot])`)

test.describe(`Reader PDF (${ENGINE_ON ? 'engine' : 'old viewer'}) @reader-pdf`, () => {
  test.describe.configure({ timeout: 60_000 })
  test.afterEach(async () => {
    await Promise.all(openContexts.splice(0).map((c) => c.close()))
  })

  test('opens at page 1 with its canvas and a page jump lands on page N', async ({ browser }) => {
    const { page, bookId } = await pdfReaderPage(browser, 'open')
    await openPdf(page, bookId)
    await jumpTo(page, 23)
    await expect.poll(() => pageEl(page, 23).locator('canvas').evaluate((c: HTMLCanvasElement) => c.width).catch(() => 0), { timeout: 10_000 })
      .toBeGreaterThan(0)
  })

  test('a reload resumes the saved page', async ({ browser }) => {
    const { page, bookId } = await pdfReaderPage(browser, 'resume')
    await openPdf(page, bookId)
    await jumpTo(page, 12)
    // On the SERVER, not just this tab: the debounced PUT has landed.
    await expect.poll(async () => {
      const resp = await page.context().request.get(`${API_URL}/me/books/${bookId}/progress`, { headers: API_HEADERS })
      return resp.ok() ? (await resp.json())?.locator : null
    }, { timeout: 15_000 }).toBe('page:12')

    // A fresh tab, not page.reload(): Chrome's own scroll restoration would hide a broken resume.
    const context = page.context()
    await page.close()
    const reopened = await context.newPage()
    await openPdf(reopened, bookId, 12)
    await expect.poll(() => pageCoversMiddle(reopened, 12), { timeout: 10_000 }).toBe(true)
  })

  test('a selection saves a pdf-anchored highlight that repaints after a reload', async ({ browser }) => {
    const { page, bookId } = await pdfReaderPage(browser, 'hl')
    await openPdf(page, bookId)

    // Select a whole line of page 1's text layer, as a mouse drag would.
    const selected = await pageEl(page, 1).evaluate((el) => {
      const span = Array.from(el.querySelectorAll('.textLayer span')).find((s) => (s.textContent ?? '').trim().length > 20)
      const text = span?.firstChild
      if (!text) return ''
      const range = document.createRange()
      range.selectNodeContents(text)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return range.toString().trim()
    })
    expect(selected, 'page 1 must have a text line to select').not.toBe('')

    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/me\/highlights$/.test(r.url()))
    await page.getByRole('button', { name: 'Highlight yellow' }).click()
    const resp = await posted
    expect(resp.ok(), `POST /me/highlights: ${resp.status()}`).toBeTruthy()
    const body = resp.request().postDataJSON() as { userBookId: string; anchorJson: string; selectedText: string }
    expect(body.userBookId).toBe(bookId)
    expect(body.selectedText).toBe(selected)
    const anchor = JSON.parse(body.anchorJson)
    expect(anchor).toMatchObject({ kind: 'pdf', page: 1 })
    expect(anchor.rects.length).toBeGreaterThan(0)
    const hl = (await resp.json()) as { id: string }
    await expect(painted(page, hl.id).first()).toBeAttached({ timeout: 10_000 })

    const context = page.context()
    await page.close()
    const reopened = await context.newPage()
    await openPdf(reopened, bookId)
    await expect(painted(reopened, hl.id).first()).toBeAttached({ timeout: 15_000 })
  })
})
