import { test, expect } from '@playwright/test'
import { getTestData } from '../fixtures/test-data'
import { waitForReaderLoad } from '../helpers/reader'

// The `mobile` project's one test (iPhone 13 viewport, touch): a signed-out reader
// opens a chapter, sees its text, and taps through to the next one. No account —
// nothing on the reading path may need one.
//
// The chapter responses are the real ones with `html` swapped for a known line, as
// in reader-smoke.spec.ts, so the text check does not depend on the CI book's prose.

const API_URL = process.env.API_URL ?? 'http://localhost:8080'
const atChapter = (slug: string) => new RegExp(`/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(\\?|#|$)`)

test('mobile: a chapter shows its text and Next opens the next chapter', async ({ page, request }) => {
  expect(page.viewportSize()!.width, 'runs on the mobile project').toBeLessThan(500)
  const { enBook } = getTestData()
  const resp = await request.get(`${API_URL}/books/${enBook.slug}`, { headers: { Host: 'general.localhost' } })
  expect(resp.ok(), `GET /books/${enBook.slug}`).toBeTruthy()
  const chapters = [...(await resp.json()).chapters].sort((a, b) => a.chapterNumber - b.chapterNumber)
  expect(chapters.length, 'needs a book with at least two chapters').toBeGreaterThanOrEqual(2)
  const [ch1, ch2] = chapters.map((c) => c.slug as string)
  const line = (slug: string) => `Mobile smoke text of ${slug === ch1 ? 'the first' : 'the second'} chapter.`

  await page.addInitScript(() => {
    localStorage.setItem('textstack_native_language', 'en')
    localStorage.setItem('reader.onboarding.seen', '1')
  })
  await page.route(`**/books/${enBook.slug}/chapters/*`, async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    json.html = `<p>${line(json.slug)}</p>`
    await route.fulfill({ response, json })
  })

  await page.goto(`/en/books/${enBook.slug}/${ch1}`)
  await waitForReaderLoad(page)
  const article = page.locator('.reader-section__article')
  await expect(article).toContainText(line(ch1), { timeout: 15_000 })
  await expect(article).toBeInViewport()

  await page.getByRole('button', { name: 'Next chapter' }).tap()
  await expect(page).toHaveURL(atChapter(ch2))
  await expect(article).toContainText(line(ch2))
})
