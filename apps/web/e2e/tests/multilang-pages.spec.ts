import { test } from '../fixtures/auth.fixture'
import { test as baseTest, expect, request as pwRequest } from '@playwright/test'
import { getTestData } from '../fixtures/test-data'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const LANGS = ['en', 'uk'] as const

/**
 * QA-003: Multi-Language Pages
 *
 * Verifies all public pages load in both languages,
 * language switcher works, and links preserve lang prefix.
 */

// --- Public pages load in both languages ---

baseTest.describe('QA-003: Public pages load in both langs', () => {
  for (const lang of LANGS) {
    baseTest(`/${lang}/books loads`, async ({ page }) => {
      await page.goto(`/${lang}/books`)
      await page.waitForLoadState('networkidle')
      const content = page.locator('main, [role="main"], #root')
      await expect(content).toBeVisible()
      // Should have at least one book link
      const bookLinks = page.locator(`a[href^="/${lang}/books/"]`)
      await expect(bookLinks.first()).toBeVisible({ timeout: 10_000 })
    })

    baseTest(`/${lang}/authors loads`, async ({ page }) => {
      await page.goto(`/${lang}/authors`)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('main, [role="main"], #root')).toBeVisible()
    })

    baseTest(`/${lang}/genres loads`, async ({ page }) => {
      await page.goto(`/${lang}/genres`)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('main, [role="main"], #root')).toBeVisible()
    })

    baseTest(`/${lang}/search?q=test loads`, async ({ page }) => {
      await page.goto(`/${lang}/search?q=test`)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('body')).toContainText(/search|results|test|пошук|результат/i)
    })

    baseTest(`/${lang}/about loads`, async ({ page }) => {
      await page.goto(`/${lang}/about`)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('main, [role="main"], #root')).toBeVisible()
    })
  }
})

// --- Book detail pages in both languages ---

baseTest.describe('QA-003: Book detail pages load per-language', () => {
  for (const lang of LANGS) {
    baseTest(`/${lang}/books/{slug} loads correct edition`, async ({ page }) => {
      const data = getTestData()
      const book = lang === 'en' ? data.enBook : data.ukBook
      if (!book) {
        baseTest.skip()
        return
      }

      await page.goto(`/${lang}/books/${book.slug}`)
      await page.waitForLoadState('networkidle')

      // Page should contain book title
      await expect(page.locator('body')).toContainText(book.title)

      // All internal links should keep lang prefix
      const links = page.locator(`a[href^="/"]`)
      const count = await links.count()
      for (let i = 0; i < Math.min(count, 20); i++) {
        const href = await links.nth(i).getAttribute('href')
        if (!href || href === '/' || href.startsWith('/#')) continue
        // Links to books/authors/genres/search should have lang prefix
        if (/^\/(books|authors|genres|search|library|about|privacy|terms|contact)/.test(href)) {
          expect.soft(href, `link "${href}" missing lang prefix`).toMatch(/^\/(en|uk)\//)
        }
      }
    })
  }
})

// --- Reader loads in both languages ---

baseTest.describe('QA-003: Reader loads per-language', () => {
  for (const lang of LANGS) {
    baseTest(`/${lang} reader opens first chapter`, async ({ page }) => {
      const data = getTestData()
      const book = lang === 'en' ? data.enBook : data.ukBook
      if (!book) {
        baseTest.skip()
        return
      }

      await page.goto(`/${lang}/books/${book.slug}/${book.firstChapterSlug}`)
      await page.waitForSelector('#reader-content.reader-main, .reader-page', { timeout: 15_000 })

      // URL should preserve language
      expect(page.url()).toContain(`/${lang}/`)
    })
  }
})

// --- Language switcher preserves path ---

baseTest.describe('QA-003: Language switcher', () => {
  baseTest('switching en→uk on /en/books keeps /books path', async ({ page }) => {
    await page.goto('/en/books')
    await page.waitForLoadState('networkidle')

    // Click language switcher
    const switcher = page.locator('.language-switcher, [data-testid="language-switcher"]')
    if (await switcher.isVisible({ timeout: 3000 }).catch(() => false)) {
      await switcher.click()
      const ukOption = page.locator('text=UA, text=UK, text=Українська').first()
      if (await ukOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await ukOption.click()
        await page.waitForLoadState('networkidle')
        expect(page.url()).toContain('/uk/books')
      }
    }
  })

  baseTest('switching uk→en on /uk/books keeps /books path', async ({ page }) => {
    await page.goto('/uk/books')
    await page.waitForLoadState('networkidle')

    const switcher = page.locator('.language-switcher, [data-testid="language-switcher"]')
    if (await switcher.isVisible({ timeout: 3000 }).catch(() => false)) {
      await switcher.click()
      const enOption = page.locator('text=EN, text=English').first()
      if (await enOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await enOption.click()
        await page.waitForLoadState('networkidle')
        expect(page.url()).toContain('/en/books')
      }
    }
  })
})

// --- Internal links preserve language prefix ---

baseTest.describe('QA-003: Navigation links keep lang prefix', () => {
  for (const lang of LANGS) {
    baseTest(`header/nav links on /${lang}/books use /${lang}/ prefix`, async ({ page }) => {
      await page.goto(`/${lang}/books`)
      await page.waitForLoadState('networkidle')

      // Check header navigation links
      const navLinks = page.locator('header a[href^="/"], nav a[href^="/"]')
      const count = await navLinks.count()
      for (let i = 0; i < count; i++) {
        const href = await navLinks.nth(i).getAttribute('href')
        if (!href || href === '/') continue
        // Internal page links should have correct lang
        if (/^\/(books|authors|genres|search|library|about)/.test(href)) {
          expect.soft(href, `nav link "${href}" wrong lang`).toContain(`/${lang}/`)
        }
      }
    })
  }
})

// --- BUG: Library list view hardcodes /en/ for user books ---

test.describe('QA-003: Library user-book links respect language', () => {
  const API_URL = process.env.API_URL ?? 'http://localhost:8080'

  // Serial: beforeAll runs once across both tests
  test.describe.configure({ mode: 'serial' })

  // Upload a test book before tests so user has at least one uploaded book
  test.beforeAll(async () => {
    const authFile = path.resolve(__dirname, '../.auth/user.json')
    const ctx = await pwRequest.newContext({
      baseURL: API_URL,
      storageState: authFile,
      extraHTTPHeaders: { Host: 'general.localhost' },
    })

    // Check if user already has Ready books
    const booksResp = await ctx.get('/me/books')
    const books = await booksResp.json() as any[]
    const readyBooks = books.filter((b: any) => b.status === 'Ready')

    if (readyBooks.length > 0) {
      console.log(`User already has ${readyBooks.length} ready book(s), skipping upload`)
      await ctx.dispose()
      return
    }

    // Upload test EPUB
    console.log('Uploading test book for library lang tests...')
    const epubPath = path.resolve(__dirname, '../fixtures/test-book-en.epub')
    const fileBuffer = fs.readFileSync(epubPath)

    const uploadResp = await ctx.post('/me/books/upload', {
      multipart: {
        file: { name: 'test-book-en.epub', mimeType: 'application/epub+zip', buffer: fileBuffer },
        title: 'E2E Lang Test Book',
        language: 'en',
      },
    })

    if (!uploadResp.ok()) {
      console.warn('Upload failed:', uploadResp.status(), await uploadResp.text())
      await ctx.dispose()
      return
    }

    const uploaded = await uploadResp.json() as { id: string }
    console.log('Uploaded book:', uploaded.id, '— waiting for ingestion...')

    // Poll until Ready or Failed (max 60s)
    for (let i = 0; i < 30; i++) {
      const checkResp = await ctx.get(`/me/books/${uploaded.id}`)
      if (!checkResp.ok()) {
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      const book = await checkResp.json() as { status: string }
      if (book.status === 'Ready') {
        console.log('Book ingestion complete')
        break
      }
      if (book.status === 'Failed') {
        console.warn('Book ingestion failed')
        break
      }
      await new Promise(r => setTimeout(r, 2000))
    }

    await ctx.dispose()
  })

  test('list view links use current language, not hardcoded /en/', async ({ authedPage: page }) => {
    // Go to UK library
    await page.goto('/uk/library')
    await page.waitForLoadState('networkidle')

    // Switch to uploads tab
    const uploadsTab = page.locator('button:has-text("Uploads"), button:has-text("Завантажені"), [data-tab="uploads"]')
    if (await uploadsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await uploadsTab.click()
      await page.waitForTimeout(1000)
    }

    // Switch to list view
    const listToggle = page.locator('button[aria-label*="list" i], button[aria-label*="List" i], .library-page__view-toggle button:last-child')
    if (await listToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
      await listToggle.click()
      await page.waitForTimeout(500)
    }

    // Check user-book links in list view
    const userBookLinks = page.locator('.library-list-item a[href*="/library/my/"]')
    const count = await userBookLinks.count()
    expect(count, 'should have at least one uploaded book link').toBeGreaterThan(0)

    // BUG: LibraryPage.tsx:455 hardcodes /en/ in list view
    // All links should use /uk/ since we're on /uk/library
    for (let i = 0; i < count; i++) {
      const href = await userBookLinks.nth(i).getAttribute('href')
      expect.soft(href, `user-book link "${href}" should use /uk/ not /en/`).toMatch(/^\/uk\/library\/my\//)
    }
  })

  test('grid view links use current language (control test)', async ({ authedPage: page }) => {
    // Go to UK library
    await page.goto('/uk/library')
    await page.waitForLoadState('networkidle')

    // Switch to uploads tab
    const uploadsTab = page.locator('button:has-text("Uploads"), button:has-text("Завантажені"), [data-tab="uploads"]')
    if (await uploadsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await uploadsTab.click()
      await page.waitForTimeout(1000)
    }

    // Ensure grid view (default)
    const gridToggle = page.locator('button[aria-label*="grid" i], button[aria-label*="Grid" i], .library-page__view-toggle button:first-child')
    if (await gridToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
      await gridToggle.click()
      await page.waitForTimeout(500)
    }

    // Grid view user-book links (UserBookCard uses language correctly)
    const userBookLinks = page.locator('.user-book-card a[href*="/library/my/"]')
    const count = await userBookLinks.count()
    expect(count, 'should have at least one uploaded book link').toBeGreaterThan(0)

    for (let i = 0; i < count; i++) {
      const href = await userBookLinks.nth(i).getAttribute('href')
      expect.soft(href, `grid link "${href}" should use /uk/`).toMatch(/^\/uk\/library\/my\//)
    }
  })
})

// --- Cross-language book access from library ---

test.describe('QA-003: Cross-lang book in library', () => {
  test('EN book detail page links use /en/ prefix', async ({ authedPage: page }) => {
    const { enBook } = getTestData()

    await page.goto(`/en/books/${enBook.slug}`)
    await page.waitForLoadState('networkidle')

    // "Read" / "Start reading" button should link to /en/
    const readBtn = page.locator('a[href*="/books/"][href*="/"]').filter({ hasText: /read|start|читати/i })
    if (await readBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const href = await readBtn.getAttribute('href')
      expect(href).toContain('/en/')
    }
  })

  test('UK book detail page links use /uk/ prefix', async ({ authedPage: page }) => {
    const { ukBook } = getTestData()
    if (!ukBook) {
      test.skip()
      return
    }

    await page.goto(`/uk/books/${ukBook.slug}`)
    await page.waitForLoadState('networkidle')

    const readBtn = page.locator('a[href*="/books/"][href*="/"]').filter({ hasText: /read|start|читати/i })
    if (await readBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const href = await readBtn.getAttribute('href')
      expect(href).toContain('/uk/')
    }
  })
})
