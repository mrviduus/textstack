import type { Page } from '@playwright/test'

export async function waitForReaderLoad(page: Page) {
  await page.waitForLoadState('domcontentloaded')
  // Wait for reader page to render (not error/loading state)
  await page.waitForSelector('#reader-content.reader-main, .reader-page', { timeout: 30_000 })
  // Ensure no error state
  const error = page.locator('.reader-error')
  if (await error.isVisible({ timeout: 1000 }).catch(() => false)) {
    throw new Error('Reader showed error state: ' + await error.textContent())
  }
}
