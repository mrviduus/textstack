import { test } from '../fixtures/auth.fixture'
import { expect } from '@playwright/test'
import { getTestData } from '../fixtures/test-data'
import { waitForReaderLoad } from '../helpers/reader'

test.describe('Mobile Reader', () => {
  test('reader uses scroll mode on all breakpoints', async ({ authedPage: page }) => {
    const { enBook } = getTestData()
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    const container = page.locator('.reader-section').first()
    await expect(container).toBeVisible()

    // Legacy pagination artefacts must be gone
    await expect(page.locator('.reader-page-nav')).toHaveCount(0)
    await expect(page.locator('.reader-page--scroll-mode')).toHaveCount(0)
  })
})
