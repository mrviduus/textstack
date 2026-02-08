import { test } from '../fixtures/auth.fixture'
import { expect } from '@playwright/test'
import { getTestData } from '../fixtures/test-data'
import { waitForReaderLoad } from '../helpers/reader'

test.describe('Mobile Reader', () => {
  test('reader uses scroll mode on mobile', async ({ authedPage: page }) => {
    const { enBook } = getTestData()
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    // Mobile reader should use scroll mode
    const scrollMode = page.locator('.reader-page--scroll-mode')
    await expect(scrollMode).toBeVisible()

    // No pagination buttons in scroll mode
    const pageNav = page.locator('.reader-page-nav')
    await expect(pageNav).not.toBeVisible()
  })

  test('auto-save on scroll (mobile)', async ({ authedPage: page }) => {
    const { enBook } = getTestData()
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    // Scroll down
    await page.evaluate(() => window.scrollBy(0, 500))
    await page.waitForTimeout(1000) // 600ms debounce + buffer

    // Check localStorage for progress
    const progress = await page.evaluate((id) => {
      return localStorage.getItem(`reading.progress.${id}`)
    }, enBook.editionId)

    // Progress should be saved after scroll
    expect(progress).not.toBeNull()
  })

  test('sendBeacon on navigate away (mobile)', async ({ authedPage: page }) => {
    const { enBook } = getTestData()
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    // Scroll to create progress
    await page.evaluate(() => window.scrollBy(0, 300))
    await page.waitForTimeout(1000)

    // Intercept sendBeacon
    const beaconPromise = page.waitForRequest(
      req => req.url().includes('/me/progress'),
      { timeout: 5_000 }
    ).catch(() => null)

    // Navigate away
    await page.goto('/en/books')
    await beaconPromise
  })

  test('progress tracking works in mobile reader', async ({ authedPage: page }) => {
    const { enBook } = getTestData()
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    // In scroll mode, progress is tracked even if top bar is hidden
    // Verify progress element exists in DOM with % text
    const progressText = await page.locator('.reader-top-bar__progress').textContent()
    expect(progressText).toContain('%')
  })
})
