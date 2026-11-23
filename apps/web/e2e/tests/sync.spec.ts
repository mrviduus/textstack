import path from 'path'
import { fileURLToPath } from 'url'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { testLogin } from '../helpers/api'

// @sync — the web app on the V2 sync API (#1025 M2.7): an upload, the library
// feed and a delete go through /me/v2. Reading on V2 (position, highlights, words) is reader.spec.ts:
// /read opens the V2 reader, so the transitional reader is not reachable here. Skips when the probe
// answers 404 (a server without /me/v2) unless SYNC_E2E=1, which CI sets. Every wait is a poll on a real signal.
//
// Content: a 3-chapter EPUB fixture (50 paragraphs each), uploaded by a fresh user each run, so the
// sha256 lookup never finds an earlier copy. The worker extracts its chapters (the transitional reader).

const API_URL = process.env.API_URL ?? 'http://localhost:8080'
const API_HEADERS = { Host: 'general.localhost' }
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, '../fixtures/v2-sync.epub')
const TITLE = 'E2E V2 sync' // the fixture's own dc:title, read by the reader page before the import (#1426)

async function syncGet<T>(request: APIRequestContext, route: string): Promise<T | null> {
  const resp = await request.get(`${API_URL}/me/v2${route}`, { headers: API_HEADERS })
  return resp.ok() ? ((await resp.json()) as T) : null
}

test.describe('Sync @sync', () => {
  test.describe.configure({ timeout: 180_000 })

  test('upload, library feed and delete, all on /me/v2', async ({ browser }) => {
    const context = await browser.newContext()
    const request = context.request
    const email = `e2e-v2-${Date.now()}-${test.info().repeatEachIndex}@textstack.app`
    await testLogin(request, email)
    const status = await request.get(`${API_URL}/me/v2/status`, { headers: API_HEADERS })
    // SYNC_E2E=1 (CI): a 404 fails instead of skipping, so CI cannot go green untested.
    test.skip(status.status() === 404 && process.env.SYNC_E2E !== '1', '/me/v2 is not mapped on this server')
    expect(status.ok(), `GET /me/v2/status: ${status.status()}`).toBeTruthy()
    await context.addInitScript(() => {
      localStorage.setItem('textstack_native_language', 'en')
      localStorage.setItem('reader.onboarding.seen', '1')
    })
    const page = await context.newPage()

    // Upload: sha256, import, parts, complete — then the reader; the worker still extracts the chapters (until ADR-033 P5).
    await page.goto('/en/library')
    await page.locator('.site-header__upload-btn').click()
    const imported = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/me\/v2\/books\/[0-9a-f-]{36}$/.test(r.url()))
    await page.locator('.upload-modal input[type="file"]').setInputFiles(FIXTURE)
    const importResp = await imported
    expect(importResp.status(), `import: ${await importResp.text()}`).toBe(201)
    expect(importResp.request().postDataJSON()).toMatchObject({ title: TITLE, language: 'en' })
    const { id: bookId, currentFile } = (await importResp.json()) as { id: string; currentFile: { id: string } }
    // Readable once its file is in (ADR-033): the modal drops straight into the reader.
    await expect(page).toHaveURL(new RegExp(`/en/library/my/${bookId}/read`), { timeout: 30_000 })

    await expect.poll(async () => (await syncGet<{ items: unknown[] }>(request, `/books/${bookId}/files/${currentFile.id}/chapters`))?.items.length, { timeout: 120_000 }).toBe(3)

    // The library is the V2 feed.
    await page.goto('/en/library')
    await expect(page.locator(`[data-book-id="${bookId}"]`)).toContainText(TITLE, { timeout: 15_000 })

    // Delete: the card goes, the feed keeps the book as removed.
    await page.goto('/en/library')
    const row = page.locator(`[data-book-id="${bookId}"]`)
    await row.getByRole('button', { name: 'Options' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page.locator('.confirm-delete-modal__btn--danger').click()
    await expect(row).toHaveCount(0, { timeout: 15_000 })
    const library = await syncGet<{ items: { id: string; removedAt: string | null }[] }>(request, '/library/changes')
    expect(library!.items.find((b) => b.id === bookId)?.removedAt).toBeTruthy()

    await context.close()
  })
})
