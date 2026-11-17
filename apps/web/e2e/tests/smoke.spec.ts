import { test, expect } from '@playwright/test'

// @smoke — cheap, deterministic wiring: did the page render at all, does the route resolve, is
// the API answering. The whole suite gates a pull request in CI's single V2 pass (.github/workflows/ci.yml).
test.describe('Smoke tests @smoke', () => {
  test('home page loads', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/TextStack/)
  })

  test('404 page for invalid route', async ({ page }) => {
    await page.goto('/en/nonexistent-page-xyz')
    await expect(page.locator('body')).toContainText(/not found|404/i)
  })

  // These two URLs are submitted to Google Play: the privacy policy is a store-listing field and the deletion page
  // satisfies the account-deletion requirement. If either stops resolving, the
  // listing breaks and nothing else would tell us. Wiring only — that the page exists
  // and rendered its heading. What it *says* is covered by the locale parity test.
  test('privacy policy URL resolves and renders', async ({ page }) => {
    await page.goto('/en/privacy')
    await expect(page.getByRole('heading', { name: 'Privacy Policy', level: 1 })).toBeVisible()
  })

  test('account-deletion URL resolves and renders', async ({ page }) => {
    await page.goto('/en/delete-account')
    await expect(page.getByRole('heading', { name: 'Delete your account', level: 1 })).toBeVisible()
  })

  test('API health endpoint responds', async ({ request }) => {
    const apiURL = process.env.API_URL ?? 'http://localhost:8080'
    const resp = await request.get(`${apiURL}/health`)
    expect(resp.status()).toBe(200)
  })
})
