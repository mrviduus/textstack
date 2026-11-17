import { test, expect } from '@playwright/test'

/**
 * Highlights — the screen (its review route retired at M6).
 *
 * The expectation is on an element of this screen that renders signed in or out —
 * never a word the tab bar or another screen could also show.
 */
test.describe('Highlights', () => {
  test('renders its search field', async ({ page }) => {
    await page.goto('/highlights')
    await page.waitForLoadState('networkidle')
    await expect(page.getByPlaceholder('Search highlights...')).toBeVisible({ timeout: 15000 })
  })
})
