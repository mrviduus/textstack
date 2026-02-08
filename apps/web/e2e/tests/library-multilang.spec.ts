import { test } from '../fixtures/auth.fixture'
import { expect } from '@playwright/test'
import { getTestData } from '../fixtures/test-data'

test.describe('QA-002: Multi-Language Library Navigation', () => {
  test('UK book from EN library opens with /uk/ prefix', async ({ authedPage: page }) => {
    const { ukBook } = getTestData()
    if (!ukBook) {
      test.skip()
      return
    }

    // First, add UK book to library by reading it briefly
    await page.goto(`/uk/books/${ukBook.slug}/${ukBook.firstChapterSlug}`)
    await page.waitForTimeout(4000) // wait for auto-save + library add

    // Go to EN library
    await page.goto('/en/library')
    await page.waitForLoadState('networkidle')

    // Find the UK book in library
    const bookLinks = page.locator('.library-list-item__title a, .library-card__title a, .library-list-item__cover, .library-card__cover')
    const count = await bookLinks.count()

    for (let i = 0; i < count; i++) {
      const href = await bookLinks.nth(i).getAttribute('href')
      if (href?.includes(ukBook.slug)) {
        // UK book link should use /uk/ prefix, not /en/
        expect(href).toContain('/uk/')
        break
      }
    }
  })

  test('EN book from UK library opens with /en/ prefix', async ({ authedPage: page }) => {
    const { enBook } = getTestData()

    // First, add EN book to library
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await page.waitForTimeout(4000)

    // Switch to UK UI and go to library
    await page.goto('/uk/library')
    await page.waitForLoadState('networkidle')

    // Find the EN book in library
    const bookLinks = page.locator('.library-list-item__title a, .library-card__title a, .library-list-item__cover, .library-card__cover')
    const count = await bookLinks.count()

    for (let i = 0; i < count; i++) {
      const href = await bookLinks.nth(i).getAttribute('href')
      if (href?.includes(enBook.slug)) {
        expect(href).toContain('/en/')
        break
      }
    }
  })

  test('resume reading uses correct language prefix', async ({ authedPage: page }) => {
    const { ukBook } = getTestData()
    if (!ukBook) {
      test.skip()
      return
    }

    // Read UK book
    await page.goto(`/uk/books/${ukBook.slug}/${ukBook.firstChapterSlug}`)
    await page.waitForTimeout(4000)

    // Go to EN library and click the UK book
    await page.goto('/en/library')
    await page.waitForLoadState('networkidle')

    const bookItem = page.locator(`.library-list-item:has-text("${ukBook.title}"), .library-card:has-text("${ukBook.title}")`)
    if (await bookItem.isVisible()) {
      const link = bookItem.locator('a').first()
      await link.click()
      await page.waitForURL(/\/books\//)
      // Should navigate to /uk/ not /en/
      expect(page.url()).toContain('/uk/')
    }
  })
})
