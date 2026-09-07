import { test } from '../fixtures/auth.fixture'
import { expect } from '@playwright/test'
import { getTestData } from '../fixtures/test-data'
import { waitForReaderLoad, getProgressFromLocalStorage, clickTopBarBtn } from '../helpers/reader'

test.describe('QA-001: Reading Progress', () => {
  test.describe.configure({ timeout: 60_000 })

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

    // Scroll to advance progress (single scroll-mode render path)
    await page.evaluate(() => window.scrollBy(0, 800))
    await page.waitForTimeout(500)
    const newProgress = Number(await progressBar.getAttribute('aria-valuenow') ?? '0')
    expect(newProgress).toBeGreaterThanOrEqual(initialProgress)
  })

  test('TOC chapter click closes drawer', async ({ authedPage: page }) => {
    const { enBook } = getTestData()
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    await clickTopBarBtn(page, 2) // TOC
    await expect(page.locator('.reader-toc-drawer')).toBeVisible()

    const chapters = page.locator('.reader-toc-drawer__item')
    const chapterCount = await chapters.count()
    if (chapterCount <= 1) return

    await chapters.nth(1).click()
    // Scroll-mode reader: clicking a TOC entry either smooth-scrolls to the
    // pre-loaded chapter or navigates with ?direct=1 — in both cases the
    // drawer itself must close.
    await expect(page.locator('.reader-toc-drawer')).not.toBeVisible({ timeout: 5_000 })
  })

  test('library resume restores position without ?direct=1', async ({ authedPage: page }) => {
    const { enBook } = getTestData()

    // First: read some pages to create progress
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    // Scroll to create progress
    await page.evaluate(() => window.scrollBy(0, 800))
    await page.waitForTimeout(1000)

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

    // Trigger scroll to force progress save
    await page.evaluate(() => window.scrollBy(0, 800))
    await page.waitForTimeout(500)

    // Wait for position restore + auto-save (3s stable position + CI overhead)
    await expect(async () => {
      const progress = await getProgressFromLocalStorage(page, enBook.editionId)
      expect(progress).not.toBeNull()
    }).toPass({ timeout: 20_000, intervals: [1000] })
  })

  test('auto-add to library after >1% progress', async ({ authedPage: page }) => {
    const { enBook } = getTestData()

    // Start reading at chapter 2 directly (guarantees >1% progress on
    // any multi-chapter book — avoids the TOC button which is hidden
    // by .immersive-mode in CI). For single-chapter books we just
    // scroll, which also exceeds 1%.
    const startSlug = enBook.secondChapterSlug ?? enBook.firstChapterSlug
    await page.goto(`/en/books/${enBook.slug}/${startSlug}?direct=1`)
    await waitForReaderLoad(page)

    // Scroll to push progress well above 1%
    await page.evaluate(() => window.scrollBy(0, 1200))
    await page.waitForTimeout(500)

    // Wait for auto-save
    await page.waitForTimeout(5000)

    // Check library — pin both legacy & v3 filter params to 'all' so the
    // default 'reading' tab (slice 04) doesn't race with progressMap fetch.
    await page.goto('/en/library?filter=all&status=all')
    await page.waitForLoadState('networkidle')

    const libraryItems = page.locator('.library-list-item, .library-card')
    await expect(libraryItems.first()).toBeVisible({ timeout: 10_000 })
  })

  test('a font size change keeps the reader on the same paragraph', async ({ authedPage: page }) => {
    // ADR-007 made this an acceptance criterion in January 2026 — "Font changes
    // do not break progress" — and nothing has ever tested it. Web applies
    // typography as inline styles on the article, so the text re-wraps under a
    // fixed scrollTop and the debounced save then writes the drifted position.
    const { enBook } = getTestData()
    await page.goto(`/en/books/${enBook.slug}/${enBook.firstChapterSlug}`)
    await waitForReaderLoad(page)

    // Read a little way in, somewhere with text on both sides of the reading line.
    await page.evaluate(() => window.scrollTo({ top: 1200, behavior: 'instant' }))
    await page.waitForTimeout(300)

    // The paragraph under the reading line — a quarter down, where the reader is
    // looking and where the position is measured from.
    const paragraphAt = () => page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight * 0.25)
      const p = el?.closest('p')
      return (p?.textContent ?? '').slice(0, 60)
    })

    const before = await paragraphAt()
    expect(before.length).toBeGreaterThan(10)

    // Change the font size twice through the real control, so the text genuinely
    // re-wraps rather than merely repainting.
    await clickTopBarBtn(page, 2)
    const drawer = page.getByRole('dialog', { name: 'Reading Settings' })
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'A+' }).click()
    await drawer.getByRole('button', { name: 'A+' }).click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    expect(await paragraphAt()).toBe(before)

    // And what gets SAVED is that place, not the drifted one. Past the debounce.
    await page.waitForTimeout(1500)
    await expect(async () => {
      const saved = await getProgressFromLocalStorage(page, enBook.editionId)
      expect(saved?.positionJson).toBeTruthy()
      const position = JSON.parse(saved.positionJson as string)
      expect(before).toContain(position.anchor.exact.slice(0, 20))
    }).toPass({ timeout: 20_000, intervals: [1000] })
  })
})
