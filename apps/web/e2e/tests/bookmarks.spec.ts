import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { getTestData, type BookTestData } from '../fixtures/test-data'
import { waitForReaderLoad } from '../helpers/reader'

// QA-004: a bookmark reaches the server and comes back; a removed one is gone there too.
// Each test signs in as its own user with no bookmarks for the book, so parallel specs
// and CI retries cannot see each other's rows.

const API_URL = process.env.API_URL ?? 'http://localhost:8080'
const API_HEADERS = { Host: 'general.localhost' }

const openContexts: BrowserContext[] = []
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close()))
})

interface ServerBookmark { id: string; locator: string }

async function bookmarkReader(browser: Browser, name: string) {
  const email = `e2e-bookmarks-${name}-${test.info().repeatEachIndex}@textstack.app`
  const context = await browser.newContext()
  openContexts.push(context)
  const request = context.request
  const login = await request.post(`${API_URL}/auth/test-login`, { data: { email }, headers: API_HEADERS })
  expect(login.ok(), `test-login ${email}: ${login.status()}`).toBeTruthy()

  const { enBook } = getTestData()
  const serverBookmarks = async (): Promise<ServerBookmark[]> => {
    const resp = await request.get(`${API_URL}/me/bookmarks/${enBook.editionId}`, { headers: API_HEADERS })
    expect(resp.ok(), `GET /me/bookmarks: ${resp.status()}`).toBeTruthy()
    return resp.json()
  }
  for (const b of await serverBookmarks()) {
    await request.delete(`${API_URL}/me/bookmarks/${b.id}`, { headers: API_HEADERS })
  }

  await skipOnboarding(context)
  return { context, enBook, serverBookmarks }
}

const skipOnboarding = (context: BrowserContext) =>
  context.addInitScript(() => {
    localStorage.setItem('textstack_native_language', 'en')
    localStorage.setItem('reader.onboarding.seen', '1')
  })

/**
 * The same session in a new browser context: cookies carry over, IndexedDB does not,
 * so whatever bookmarks it shows came from the server.
 */
async function sameUserFreshDevice(browser: Browser, context: BrowserContext) {
  const fresh = await browser.newContext({ storageState: await context.storageState() })
  openContexts.push(fresh)
  await skipOnboarding(fresh)
  return fresh
}

async function openReader(context: BrowserContext, book: BookTestData): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`/en/books/${book.slug}/${book.firstChapterSlug}`)
  await waitForReaderLoad(page)
  return page
}

// The top bar auto-hides with pointer-events: none (immersive mode), so its buttons
// are clicked with dispatchEvent. By title, never by position: Search is conditional.
const topBar = (page: Page) => page.locator('.reader-top-bar')

async function openBookmarksTab(page: Page) {
  await topBar(page).getByTitle('Table of Contents').dispatchEvent('click')
  const drawer = page.getByRole('dialog', { name: 'Table of Contents' })
  await expect(drawer).toBeVisible()
  await drawer.getByRole('button', { name: /^Bookmarks/ }).click()
  return drawer
}

test.describe('QA-004: Bookmarks', () => {
  test('an added bookmark reaches the server and is in the drawer after a reload', async ({ browser }) => {
    const { context, enBook, serverBookmarks } = await bookmarkReader(browser, 'add')
    const page = await openReader(context, enBook)

    const posted = page.waitForResponse(
      (r) => r.url().includes('/me/bookmarks') && r.request().method() === 'POST',
      { timeout: 10_000 },
    )
    await topBar(page).getByTitle('Add bookmark').dispatchEvent('click')
    expect((await posted).ok(), 'POST /me/bookmarks').toBeTruthy()
    await expect(topBar(page).getByTitle('Remove bookmark')).toBeAttached()
    await expect.poll(async () => (await serverBookmarks()).map((b) => b.locator))
      .toEqual([`chapter:${enBook.firstChapterSlug}`])

    const reopened = await openReader(await sameUserFreshDevice(browser, context), enBook)
    await expect(topBar(reopened).getByTitle('Remove bookmark')).toBeAttached()
    const drawer = await openBookmarksTab(reopened)
    await expect(drawer.getByTitle('Remove bookmark')).toHaveCount(1)
  })

  test('a bookmark removed in the drawer is gone from the server and the drawer', async ({ browser }) => {
    const { context, enBook, serverBookmarks } = await bookmarkReader(browser, 'remove')
    const page = await openReader(context, enBook)

    // Added through the UI, as a reader would; the first test pins that this works.
    await topBar(page).getByTitle('Add bookmark').dispatchEvent('click')
    await expect.poll(async () => (await serverBookmarks()).length).toBe(1)

    const drawer = await openBookmarksTab(page)
    const deleted = page.waitForResponse(
      (r) => r.url().includes('/me/bookmarks/') && r.request().method() === 'DELETE',
      { timeout: 10_000 },
    )
    await drawer.getByTitle('Remove bookmark').click()
    expect((await deleted).ok(), 'DELETE /me/bookmarks/{id}').toBeTruthy()
    await expect(drawer.getByTitle('Remove bookmark')).toHaveCount(0)
    await expect(topBar(page).getByTitle('Add bookmark')).toBeAttached()
    await expect.poll(async () => (await serverBookmarks()).length).toBe(0)

    const reopened = await openReader(await sameUserFreshDevice(browser, context), enBook)
    await expect(topBar(reopened).getByTitle('Add bookmark')).toBeAttached()
    const reopenedDrawer = await openBookmarksTab(reopened)
    await expect(reopenedDrawer.getByTitle('Remove bookmark')).toHaveCount(0)
  })
})
