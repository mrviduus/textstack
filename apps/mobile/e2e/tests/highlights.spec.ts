import { test, expect } from '@playwright/test'

/**
 * Highlights — the screen and its review route.
 *
 * Two tests were deleted: "book type tabs visible" and "sort and color filters
 * visible". Both hid their only assertion inside an `if`, so the case they
 * existed to catch — the row missing — passed silently. They are not converted
 * here because signed out this screen renders a sign-in prompt and those rows do
 * not exist to be asserted; making the claim needs an authenticated fixture,
 * which is Lane A's job (MOBILE-TEST-PLAN.md).
 *
 * Every expectation below is on an element of this screen that renders signed
 * in or out — never a word the tab bar or another screen could also show.
 */
test.describe('Highlights', () => {
  test('renders the screen', async ({ page }) => {
    await page.goto('/highlights')
    await page.waitForLoadState('networkidle')
    // The header action exists only on this screen, signed in or not.
    await expect(
      page.getByRole('button', { name: 'Revisit highlights one at a time' }),
    ).toBeVisible({ timeout: 15000 })
  })

  test('renders its search field', async ({ page }) => {
    await page.goto('/highlights')
    await page.waitForLoadState('networkidle')
    await expect(page.getByPlaceholder('Search highlights...')).toBeVisible({ timeout: 15000 })
  })

  test('the review route renders', async ({ page }) => {
    await page.goto('/highlights/review')
    await page.waitForLoadState('networkidle')
    // The screen's header title, set in every one of its states.
    await expect(page.getByText('Revisit Highlights', { exact: true })).toBeVisible({ timeout: 15000 })
  })
})
