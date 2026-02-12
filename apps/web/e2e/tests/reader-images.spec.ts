import { test, expect } from '../fixtures/auth.fixture'
import { adminLogin, uploadBook, waitForIngestion, getEdition } from '../helpers/api'
import { waitForReaderLoad } from '../helpers/reader'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API_URL = process.env.API_URL ?? 'http://localhost:8080'

let bookSlug: string
let chapterSlug: string
let editionId: string

test.describe('Inline images in reader', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext()
    const request = ctx.request

    // Admin login
    await adminLogin(request)

    // Get site info for siteId, author, genre
    const siteResp = await request.get(`${API_URL}/site`, {
      headers: { Host: 'general.localhost' },
    })
    const site = await siteResp.json()
    const siteId = site.id

    // Get first available author
    const authorsResp = await request.get(`${API_URL}/admin/authors?limit=1`, {
      headers: { Host: 'general.localhost' },
    })
    const authors = await authorsResp.json()
    const authorId = authors.items?.[0]?.id ?? ''

    // Get first available genre
    const genresResp = await request.get(`${API_URL}/admin/genres?limit=1`, {
      headers: { Host: 'general.localhost' },
    })
    const genres = await genresResp.json()
    const genreId = genres.items?.[0]?.id ?? ''

    // Upload test EPUB with image
    const epubPath = path.resolve(__dirname, '../fixtures/test-book-images.epub')
    const result = await uploadBook(request, {
      filePath: epubPath,
      title: 'Test Book With Images',
      language: 'en',
      siteId,
      authorIds: authorId,
      genreId,
    })

    // Wait for ingestion
    const jobId = result.jobId ?? result.ingestionJobId
    await waitForIngestion(request, jobId)

    // Publish the edition
    editionId = result.editionId
    await request.post(`${API_URL}/admin/editions/${editionId}/publish`, {
      headers: { Host: 'general.localhost' },
    })

    // Get book detail to find slug + chapter slug
    const edition = await getEdition(request, editionId)
    bookSlug = edition.slug
    chapterSlug = edition.chapters?.[0]?.slug ?? ''

    await ctx.close()
  })

  test('chapter with inline images shows img elements that load', async ({ authedPage: page }) => {
    await page.goto(`/en/books/${bookSlug}/${chapterSlug}`)
    await waitForReaderLoad(page)

    // Find images in reader content (pagination or scroll mode)
    const images = page.locator('.reader-content img, .scroll-reader__chapter img')
    await expect(images.first()).toBeVisible({ timeout: 10_000 })

    const count = await images.count()
    expect(count).toBeGreaterThan(0)

    // Verify src points to asset endpoint
    const src = await images.first().getAttribute('src')
    expect(src).toMatch(/\/books\/[a-f0-9-]+\/assets\/[a-f0-9-]+/)

    // Verify image actually loaded (naturalWidth > 0)
    const naturalWidth = await images.first().evaluate((el: HTMLImageElement) => el.naturalWidth)
    expect(naturalWidth).toBeGreaterThan(0)
  })

  test('image asset endpoint returns 200 with image content-type', async ({ authedPage: page }) => {
    // Fetch chapter HTML from API to get img src
    const chapterResp = await page.request.get(`${API_URL}/books/${bookSlug}/chapters/${chapterSlug}`, {
      headers: { Host: 'general.localhost' },
    })
    expect(chapterResp.ok()).toBeTruthy()

    const chapter = await chapterResp.json()
    const html: string = chapter.html ?? chapter.content ?? ''

    // Extract img src from HTML
    const srcMatch = html.match(/src="(\/books\/[^"]+)"/)
    expect(srcMatch).not.toBeNull()

    const assetUrl = `${API_URL}${srcMatch![1]}`
    const assetResp = await page.request.get(assetUrl, {
      headers: { Host: 'general.localhost' },
    })

    expect(assetResp.status()).toBe(200)
    const contentType = assetResp.headers()['content-type']
    expect(contentType).toMatch(/^image\//)
  })
})
