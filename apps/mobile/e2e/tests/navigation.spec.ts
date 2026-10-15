import { test, expect } from '@playwright/test'

/**
 * Route reachability. Every assertion here can fail.
 *
 * The previous version could not. Three of its four tests used
 * `expect(await …isVisible().catch(() => false)).toBeTruthy()` — the catch
 * swallows the timeout and the matcher then asserts a boolean the test itself
 * produced, so a blank page passes. That shape was green throughout the week the
 * Library screen was unusable, and its Library assertion matched the word
 * "Saved", which was a tab name deleted in #452.
 */
test.describe('Navigation', () => {
  test('/ redirects rather than rendering a screen of its own', async ({ page }) => {
    // Home was deleted in #453 — `app/(tabs)/index.tsx` is now an auth-aware
    // redirect: Library when signed in, Discover otherwise. These specs run
    // signed out. `ColdResetOnResume` and `+not-found` both navigate here, so
    // the redirect existing is load-bearing.
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/(search|library)/)
  })

  test('Discover renders its search field', async ({ page }) => {
    await page.goto('/search')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('input[placeholder*="Search" i]').first()).toBeVisible({ timeout: 15000 })
  })

  test('Library signed out offers a way in', async ({ page }) => {
    await page.goto('/library')
    await page.waitForLoadState('networkidle')
    // Signed out, Library renders an EmptyState with a Sign In action. It must
    // never be blank: this route is the app's front door since #453.
    await expect(
      page.getByText('An account is only needed to carry your library to another phone.', { exact: false }),
    ).toBeVisible({ timeout: 15000 })
  })

  test('Profile renders', async ({ page }) => {
    await page.goto('/profile')
    await page.waitForLoadState('networkidle')
    // Signed out (this lane): the screen's own prompt, not a word the tab bar could also hold.
    await expect(page.getByText('Sign in to track your reading', { exact: true })).toBeVisible({ timeout: 15000 })
  })
})
