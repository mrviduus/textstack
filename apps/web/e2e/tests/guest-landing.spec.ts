import { test, expect } from '@playwright/test'
import { getTestData } from '../fixtures/test-data'

// Regression guard: on landing pages, a clean anonymous visit must NOT trigger
// POST /auth/guest. Bootstrap is read-only by design (AuthContext.tsx:I1) and
// guest creation is demand-driven (ensureSession on commitment signals — file
// upload, vocabulary tap threshold). If someone wires ensureSession into a
// useEffect / hover / prefetch, this fails — keeping bot traffic on SSG pages
// from creating DB rows.
//
// Each page's own h1 is asserted first: a removed route renders the 404 page,
// which makes no guest call either, and would pass the guard without it.

// Lazy: getTestData() is read at test time, after global-setup wrote it.
const PAGES: { name: string; page: () => { url: string; heading: string } }[] = [
  { name: '/en', page: () => ({ url: '/en', heading: 'Finish the book you keep quitting.' }) },
  { name: '/en/mcp', page: () => ({ url: '/en/mcp', heading: 'Connect TextStack to your AI assistant' }) },
  {
    name: 'a book page',
    page: () => {
      const { enBook } = getTestData()
      return { url: `/en/books/${enBook.slug}`, heading: enBook.title }
    },
  },
]

test.describe('guest creation guard', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  for (const { name, page: target } of PAGES) {
    test(`${name} does not trigger POST /auth/guest on mount`, async ({ page }) => {
      const { url, heading } = target()
      const guestCalls: string[] = []
      page.on('request', (req) => {
        if (req.url().includes('/auth/guest') && req.method() === 'POST') guestCalls.push(req.url())
      })

      await page.goto(url)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible({ timeout: 15_000 })
      await page.waitForLoadState('networkidle')

      expect(guestCalls, `Unexpected POST /auth/guest calls on ${url}: ${guestCalls.join(', ')}`).toHaveLength(0)
    })
  }
})
