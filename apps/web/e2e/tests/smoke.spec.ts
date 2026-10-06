import { test, expect } from '@playwright/test'

// @smoke — this file and reader-smoke.spec.ts (@reader-smoke) are the only parts of
// the E2E suite that gate a pull request. Everything here must be cheap, deterministic, and about *wiring*: did the
// page render at all, does the route resolve, is the API answering. Nothing that
// needs a fixture, a login, or a timing assumption belongs in this file — the
// reader's logic gate lives in reader-smoke.spec.ts for that reason.
//
// The rest of the suite runs non-blocking on PRs and nightly against production.
// Rationale in the E2E steps of .github/workflows/ci.yml.
test.describe('Smoke tests @smoke', () => {
  test('home page loads', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/TextStack/)
  })

  test('/en/books lists books', async ({ page }) => {
    await page.goto('/en/books')
    await page.waitForLoadState('networkidle')
    const content = page.locator('main, [role="main"], #root')
    await expect(content).toBeVisible()
  })

  test('/en/search returns results page', async ({ page }) => {
    await page.goto('/en/search?q=test')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).toContainText(/search|results|test/i)
  })

  test('404 page for invalid route', async ({ page }) => {
    await page.goto('/en/nonexistent-page-xyz')
    await expect(page.locator('body')).toContainText(/not found|404/i)
  })

  // In the gate rather than the reported half, because these two URLs are submitted
  // to Google Play: the privacy policy is a store-listing field and the deletion page
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
