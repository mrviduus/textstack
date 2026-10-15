import { test, expect } from '@playwright/test'

/**
 * The catalog list screen.
 *
 * A third test lived here — "sort chips are clickable" — which clicked two
 * chips if they happened to be visible and asserted nothing at all. It could
 * not fail, and it could not pass either; it only ran. Deleted rather than
 * repaired, because asserting that a sort actually reorders the list needs
 * fixture data this lane does not have yet (see MOBILE-TEST-PLAN.md, Lane A).
 */
test.describe('Books', () => {
  test('renders a search field and the sort row', async ({ page }) => {
    await page.goto('/books')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('input[placeholder*="Search" i]').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator('text=Recent').first()).toBeVisible({ timeout: 10000 })
  })

  test('shows either books or an empty state, never nothing', async ({ page }) => {
    await page.goto('/books')
    await page.waitForLoadState('networkidle')
    // Not the genre chip "All" — it renders whether or not the list does.
    await expect(
      page.getByTestId('book-card').first().or(page.getByText('No books yet', { exact: true })),
    ).toBeVisible({ timeout: 15000 })
  })
})
