import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { getTestData } from '../fixtures/test-data'
import { waitForReaderLoad } from '../helpers/reader'

// @reader-smoke — BLOCKING. The reader's core promise, run as its own required
// step in the e2e job (ci.yml), unlike the rest of this suite, which only
// reports. Keep it to these few tests and keep every wait a poll on a real
// signal (localStorage, the progress API, the painted overlay) — never a sleep.
//
// Content: the CI database holds one-paragraph chapters, which cannot be
// scrolled. Rather than mutate the database, each test serves the REAL chapter
// response (real ids, real prev/next, real API round trip) with its `html`
// swapped for a long, deterministic fixture. Same text locally and in CI.
//
// Isolation: every test signs in as its OWN user and clears that user's
// progress and highlights for the book first, so the parallel specs sharing
// e2e-test@textstack.app cannot move its position, and a CI retry starts clean.

const API_URL = process.env.API_URL ?? 'http://localhost:8080'
const API_HEADERS = { Host: 'general.localhost' }

// Present, identically, in BOTH chapters — a highlight anchored to it must
// paint only in the chapter it belongs to.
const SHARED_SENTENCE = 'The pond lay still and silver beneath the rising moon, and nothing stirred along its shore.'
const CH2_ONLY_SENTENCE = 'A single loon called twice from the far side of the water and then was silent.'
// Walden (Thoreau, 1854) — public domain.
const FILLER =
  'I went to the woods because I wished to live deliberately, to front only the essential facts of life, ' +
  'and see if I could not learn what it had to teach, and not, when I came to die, discover that I had not lived. ' +
  'I did not wish to live what was not life, living is so dear; nor did I wish to practise resignation, unless it was quite necessary.'

function fixtureHtml(chapter: 1 | 2): string {
  const paragraphs = Array.from({ length: 40 }, (_, i) => {
    if (i === 11) return `<p>${SHARED_SENTENCE}</p>`
    if (chapter === 2 && i === 17) return `<p>${CH2_ONLY_SENTENCE}</p>`
    return `<p>Chapter ${chapter}, paragraph ${i + 1}. ${FILLER}</p>`
  })
  return `<h1>Smoke fixture chapter ${chapter}</h1>${paragraphs.join('')}`
}

interface Book {
  slug: string
  editionId: string
  ch1: { id: string; slug: string }
  ch2: { id: string; slug: string }
}

async function loadBook(request: APIRequestContext): Promise<Book> {
  const { enBook } = getTestData()
  const resp = await request.get(`${API_URL}/books/${enBook.slug}`, { headers: API_HEADERS })
  expect(resp.ok(), `GET /books/${enBook.slug}`).toBeTruthy()
  const detail = await resp.json()
  const chapters = [...detail.chapters].sort((a, b) => a.chapterNumber - b.chapterNumber)
  expect(chapters.length, 'reader smoke needs a book with at least two chapters').toBeGreaterThanOrEqual(2)
  return {
    slug: enBook.slug,
    editionId: detail.id,
    ch1: { id: chapters[0].id, slug: chapters[0].slug },
    ch2: { id: chapters[1].id, slug: chapters[1].slug },
  }
}

// Hand-made contexts are not closed by Playwright; afterEach does it, so a failed test does not leak one.
const openContexts: BrowserContext[] = []

/** A signed-in page for a user only this test uses, with that user's state for the book wiped. */
async function readerPage(browser: Browser, name: string): Promise<{ page: Page; book: Book }> {
  // repeatEachIndex keeps `--repeat-each` flake hunts from sharing one user across parallel copies.
  const email = `e2e-reader-smoke-${name}-${test.info().repeatEachIndex}@textstack.app`
  const context = await browser.newContext()
  openContexts.push(context)
  const request = context.request
  const login = await request.post(`${API_URL}/auth/test-login`, { data: { email }, headers: API_HEADERS })
  expect(login.ok(), `test-login ${email}: ${login.status()}`).toBeTruthy()

  const book = await loadBook(request)
  await request.delete(`${API_URL}/me/progress/${book.editionId}`, { headers: API_HEADERS })
  const existing = await request.get(`${API_URL}/me/highlights/${book.editionId}`, { headers: API_HEADERS })
  if (existing.ok()) {
    for (const h of (await existing.json()) as { id: string }[]) {
      await request.delete(`${API_URL}/me/highlights/${h.id}`, { headers: API_HEADERS })
    }
  }

  await context.addInitScript(() => {
    localStorage.setItem('textstack_native_language', 'en')
    localStorage.setItem('reader.onboarding.seen', '1')
  })
  // Real response, long html. Only the chapter fetches of this book; the SPA
  // page URL has no `/chapters/` segment, so it is never matched.
  await context.route(`**/books/${book.slug}/chapters/*`, async (route) => {
    const response = await route.fetch()
    const json = await response.json()
    json.html = fixtureHtml(json.slug === book.ch1.slug ? 1 : 2)
    await route.fulfill({ response, json })
  })

  return { page: await context.newPage(), book }
}

// In-app navigation is a pushState, so waitForURL (which waits for `load`) never resolves.
const atChapter = (slug: string) => new RegExp(`/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(\\?|#|$)`)
const article = (page: Page) => page.locator('.reader-section__article')
const firstParagraph = (chapter: 1 | 2) => `Chapter ${chapter}, paragraph 1.`

/** Navigate and wait until the fixture text of that chapter is on screen. */
async function openChapter(page: Page, book: Book, chapter: 1 | 2) {
  const slug = chapter === 1 ? book.ch1.slug : book.ch2.slug
  await page.goto(`/en/books/${book.slug}/${slug}`)
  await waitForReaderLoad(page)
  await expect(article(page)).toContainText(firstParagraph(chapter), { timeout: 15_000 })
}

const localProgress = (page: Page, editionId: string) =>
  page.evaluate((id) => {
    const raw = localStorage.getItem(`reading.progress.${id}`)
    return raw ? (JSON.parse(raw) as { chapterSlug: string; locator: string }) : null
  }, editionId)

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY))

/** Restore has run once save-on-open writes this chapter; a scroll before that is overwritten by it. */
async function waitForOpenSave(page: Page, book: Book, slug: string, timeout = 15_000) {
  await expect.poll(async () => (await localProgress(page, book.editionId))?.chapterSlug, { timeout }).toBe(slug)
}

/**
 * Scroll to the middle of the chapter and wait for the reader to save exactly
 * that offset locally. Acting before the save lands races the scroll event —
 * a click in the same frame as the scroll finds no pending position to flush.
 */
async function scrollToMiddleAndSave(page: Page, book: Book, slug: string, timeout = 10_000): Promise<number> {
  const target = await page.evaluate(() => {
    const y = Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2)
    window.scrollTo({ top: y, behavior: 'instant' })
    return y
  })
  expect(target, 'fixture chapter must be long enough to scroll').toBeGreaterThan(1000)
  await expect.poll(async () => (await localProgress(page, book.editionId))?.locator, { timeout })
    .toBe(`scroll:${slug}:${target}`)
  return target
}

/** Count painted highlight groups of one colour. The overlay draws one <g> per highlight. */
const paintedCount = (page: Page, color: 'pink' | 'blue') =>
  page.evaluate((c) => {
    const groups = document.querySelectorAll<SVGGElement>('[data-highlight-overlay] g')
    return Array.from(groups).filter((g) =>
      g.style.fill.includes(`hl-${c}`)
      && Array.from(g.querySelectorAll('rect')).some((r) => Number(r.getAttribute('width')) > 0),
    ).length
  }, color)

// Tolerance for "the same place": restore re-anchors on the text, so it can land
// up to about a line away from the pixel the reader left.
const TOLERANCE_PX = 60

test.describe('Reader smoke @reader-smoke', () => {
  test.describe.configure({ timeout: 45_000 })
  test.afterEach(async () => {
    await Promise.all(openContexts.splice(0).map((c) => c.close()))
  })

  test('scroll position survives a reload', async ({ browser }) => {
    const { page, book } = await readerPage(browser, 'reload')
    await openChapter(page, book, 1)
    await waitForOpenSave(page, book, book.ch1.slug)
    const target = await scrollToMiddleAndSave(page, book, book.ch1.slug)

    // And on the SERVER, not just this tab: the debounced PUT has landed.
    await expect.poll(async () => {
      const resp = await page.context().request.get(`${API_URL}/me/progress/${book.editionId}`, { headers: API_HEADERS })
      return resp.ok() ? (await resp.json())?.locator : null
    }, { timeout: 15_000 }).toBe(`scroll:${book.ch1.slug}:${target}`)

    // A fresh tab, not page.reload(): Chrome's own scroll restoration on reload
    // would put the page back even if the reader's restore were broken.
    const context = page.context()
    await page.close()
    const reopened = await context.newPage()
    await openChapter(reopened, book, 1)
    await expect.poll(async () => Math.abs((await scrollY(reopened)) - target), { timeout: 10_000 })
      .toBeLessThanOrEqual(TOLERANCE_PX)
  })

  test('Next then Prev returns to the same place', async ({ browser }) => {
    const { page, book } = await readerPage(browser, 'nav')
    await openChapter(page, book, 1)
    await waitForOpenSave(page, book, book.ch1.slug)
    const target = await scrollToMiddleAndSave(page, book, book.ch1.slug)

    // dispatchEvent, not click(): a real click scrolls the bottom nav into view
    // first, which would move the very position under test.
    await page.locator('.reader-nav__btn--next').dispatchEvent('click')
    await expect(page).toHaveURL(atChapter(book.ch2.slug))
    await expect(article(page)).toContainText(CH2_ONLY_SENTENCE)
    // The next chapter opens at its top, not at the previous chapter's offset.
    await expect.poll(() => scrollY(page), { timeout: 10_000 }).toBeLessThanOrEqual(TOLERANCE_PX)

    await page.locator('.reader-nav__btn--prev').dispatchEvent('click')
    await expect(page).toHaveURL(atChapter(book.ch1.slug))
    await expect(article(page)).toContainText(firstParagraph(1))
    await expect.poll(async () => Math.abs((await scrollY(page)) - target), { timeout: 10_000 })
      .toBeLessThanOrEqual(TOLERANCE_PX)
  })

  test('a highlight paints in its own chapter and nowhere else', async ({ browser }) => {
    const { page, book } = await readerPage(browser, 'hl')
    const request = page.context().request
    const create = async (chapterId: string, exact: string, color: 'pink' | 'blue') => {
      const anchor = { prefix: '', exact, suffix: '', startOffset: 0, endOffset: exact.length, chapterId }
      const resp = await request.post(`${API_URL}/me/highlights`, {
        headers: API_HEADERS,
        data: { editionId: book.editionId, chapterId, anchorJson: JSON.stringify(anchor), color, selectedText: exact },
      })
      expect(resp.ok(), `create highlight: ${resp.status()} ${await resp.text()}`).toBeTruthy()
    }
    // Pink: the sentence both chapters contain, anchored to chapter 1.
    // Blue: chapter 2's own — the positive control that painting ran there at all,
    // so "no pink in chapter 2" is not just "nothing painted yet".
    await create(book.ch1.id, SHARED_SENTENCE, 'pink')
    await create(book.ch2.id, CH2_ONLY_SENTENCE, 'blue')

    await openChapter(page, book, 1)
    await expect.poll(() => paintedCount(page, 'pink'), { timeout: 15_000 }).toBe(1)
    expect(await paintedCount(page, 'blue')).toBe(0)

    await page.locator('.reader-nav__btn--next').dispatchEvent('click')
    await expect(page).toHaveURL(atChapter(book.ch2.slug))
    await expect.poll(() => paintedCount(page, 'blue'), { timeout: 15_000 }).toBe(1)
    expect(await paintedCount(page, 'pink')).toBe(0)
  })

  // `blocked`: the progress GET fails fast (offline, refused). `hung`: it never
  // answers (captive portal, stalled proxy) — the reader gives up after 3 s (#729).
  // Either way the GET is "no answer": restore falls back to this device's record
  // and the open itself is NOT saved (that would stamp an unverified place as the
  // newest write), so the signal here is the reader's own scroll being saved.
  for (const mode of ['blocked', 'hung'] as const) {
    test(`a ${mode} progress request does not stop the reader opening or saving`, async ({ browser }) => {
      const { page, book } = await readerPage(browser, mode)
      // Only the GET is broken. Writes still go through.
      await page.route(`**/me/progress/${book.editionId}`, (route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        if (mode === 'blocked') return route.abort()
        // hung: never fulfilled.
      })

      const started = Date.now()
      await openChapter(page, book, 1)
      // A scroll before restore has run is ignored (and then undone by the restore), so
      // scroll-and-check is retried. Budget: 3 s GET timeout + 1.5 s save debounce + slack.
      await expect(async () => {
        await scrollToMiddleAndSave(page, book, book.ch1.slug, 2_500)
      }).toPass({ timeout: 10_000, intervals: [250] })
      test.info().annotations.push({ type: 'saved-after-ms', description: String(Date.now() - started) })
    })
  }
})
