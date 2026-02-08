import { test } from '../fixtures/auth.fixture'
import { expect } from '@playwright/test'
import { getTestData } from '../fixtures/test-data'
import { waitForReaderLoad, getProgressFromLocalStorage } from '../helpers/reader'

test.describe('QA-001: Reading Progress', () => {
  test.beforeEach(async ({ authedPage: page }) => {
    // Clear reading progress before each test
    await page.goto('/')
    await page.evaluate(() => {
      Object.keys(localStorage)
        .filter(k => k.startsWith('reading.progress'))
        .forEach(k => localStorage.removeItem(k))
    })
  })

  test('progress bar updates when reading pages', async ({ authedPage: page }) => {
    const { enBook } = getTestData()
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    // Check footer exists (progress bar inside may be 0-width at start)
    const footer = page.locator('.reader-footer')
    await expect(footer).toBeVisible()

    const progressBar = page.locator('.reader-footer__progress-bar').first()
    const initialProgress = Number(await progressBar.getAttribute('aria-valuenow') ?? '0')
    expect(initialProgress).toBeGreaterThanOrEqual(0)

    // Navigate to next page (if pagination mode)
    const nextBtn = page.locator('.reader-page-nav button').last()
    if (await nextBtn.isVisible()) {
      await nextBtn.click()
      await page.waitForTimeout(500)
      const newProgress = Number(await progressBar.getAttribute('aria-valuenow') ?? '0')
      expect(newProgress).toBeGreaterThanOrEqual(initialProgress)
    }
  })

  test('TOC navigation uses ?direct=1', async ({ authedPage: page }) => {
    const { enBook } = getTestData()
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    // Open TOC drawer
    const tocBtn = page.locator('.reader-top-bar__btn').filter({ has: page.locator('svg') }).nth(2)
    await tocBtn.click()

    // Wait for drawer
    await expect(page.locator('.reader-toc-drawer')).toBeVisible()

    // Click second chapter
    const chapters = page.locator('.reader-toc-drawer__item')
    const chapterCount = await chapters.count()
    if (chapterCount > 1) {
      await chapters.nth(1).click()
      await page.waitForURL(/direct=1/)
      expect(page.url()).toContain('direct=1')
    }
  })

  test('library resume restores position without ?direct=1', async ({ authedPage: page }) => {
    const { enBook } = getTestData()

    // First: read some pages to create progress
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    // Navigate forward to create progress
    const nextBtn = page.locator('.reader-page-nav button').last()
    if (await nextBtn.isVisible()) {
      await nextBtn.click()
      await page.waitForTimeout(1000)
    }

    // Wait for auto-save
    await page.waitForTimeout(3500)

    // Go to library and click the book
    await page.goto('/en/library')
    await page.waitForLoadState('networkidle')

    const bookLink = page.locator('.library-list-item__title, .library-card__title').first()
    if (await bookLink.isVisible()) {
      await bookLink.click()
      await page.waitForURL(/\/books\//)
      // Library resume should NOT have ?direct=1
      expect(page.url()).not.toContain('direct=1')
    }
  })

  test('progress bar shows overall book % not chapter %', async ({ authedPage: page }) => {
    const { enBook } = getTestData()
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    const progressBar = page.locator('.reader-footer__progress-bar').first()
    const value = Number(await progressBar.getAttribute('aria-valuenow'))

    // On chapter 1 of a multi-chapter book, overall % should be < 100
    if (enBook.chapterCount > 1) {
      expect(value).toBeLessThan(100)
    }
  })

  test('auto-save to localStorage', async ({ authedPage: page }) => {
    const { enBook } = getTestData()
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    // Wait for auto-save (3s stable position)
    await page.waitForTimeout(4000)

    const progress = await getProgressFromLocalStorage(page, enBook.editionId)
    expect(progress).not.toBeNull()
  })

  test('auto-add to library after >1% progress', async ({ authedPage: page }) => {
    const { enBook } = getTestData()

    // Start reading first chapter
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    // Use TOC to jump to a later chapter (guarantees >1% progress)
    const tocBtn = page.locator('.reader-top-bar__btn').filter({ has: page.locator('svg') }).nth(2)
    await tocBtn.click()
    await expect(page.locator('.reader-toc-drawer')).toBeVisible()

    const chapters = page.locator('.reader-toc-drawer__item')
    const total = await chapters.count()
    // Jump to ~5% into the book
    const targetIdx = Math.min(Math.ceil(total * 0.05), total - 1)
    if (targetIdx > 0) {
      await chapters.nth(targetIdx).click()
      await page.waitForTimeout(2000)
    }
    await waitForReaderLoad(page)

    // Wait for auto-save
    await page.waitForTimeout(5000)

    // Check library
    await page.goto('/en/library')
    await page.waitForLoadState('networkidle')

    const libraryItems = page.locator('.library-list-item, .library-card')
    const count = await libraryItems.count()
    expect(count).toBeGreaterThan(0)
  })
})
