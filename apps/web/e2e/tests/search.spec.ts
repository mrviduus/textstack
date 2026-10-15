import { test, expect } from '@playwright/test'

test.describe('Search', () => {

  test('search input works', async ({ page }) => {
    await page.goto('/en/search')

    const searchInput = page.locator('.search-page__input')
    await expect(searchInput).toBeVisible({ timeout: 15_000 })

    // Retried, not slept: on a cold page the first fill can land before the app has
    // settled and be thrown away (CI, 2026-10-15) — then the URL never changes.
    await expect(async () => {
      await searchInput.fill('test')
      await searchInput.press('Enter')
      // URL updates via setSearchParams
      await expect(page).toHaveURL(/q=test/, { timeout: 2_000 })
    }).toPass({ timeout: 15_000 })
  })

  test('empty search shows empty state', async ({ page }) => {
    // Wait for the actual .empty-state element (Playwright auto-retries until it
    // mounts) rather than networkidle + a whole-body text match that raced the
    // SSG→CSR hydration. The empty-state only renders once the /search XHR
    // returns and `loading` flips false.
    await page.goto('/en/search?q=xyznonexistentqueryzzz')
    const emptyState = page.locator('.empty-state')
    await expect(emptyState).toBeVisible({ timeout: 20_000 })
    await expect(emptyState).toContainText(/no results/i)
  })
})
