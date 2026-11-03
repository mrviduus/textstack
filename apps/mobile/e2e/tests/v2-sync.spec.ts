import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { test, expect, type APIRequestContext } from '@playwright/test'

// @v2 — the Expo app on the V2 sync API (#1025 M2.7), driven as its web build: with Features:V2Api
// on, the library, the book, the reader's chapter, its resume place and the vocabulary list all go
// through /me/v2. Skips when /me/v2/status answers 404 (the flag is off) unless
// V2_E2E=1. Not run by CI (README §State): run it against a stack with the flag on.
//
// What this lane cannot do, and where it is covered instead:
// - the upload's bytes: the web build has no expo-file-system FileHandle, so the book is uploaded
//   here through the API by the same protocol; the app's sequencer is `src/lib/v2.test.ts`, and the
//   device byte path (`readBytes` + fetch) was checked on the Android emulator.
// - selection and highlights live in the reader WebView, which Playwright cannot drive
//   (reader-smoke.spec.ts); the V2 mapping is `src/lib/v2Highlights.test.ts`.
// - delete confirms through `Alert.alert`, a no-op on react-native-web; the switch is one line
//   (`userBooksApi.deleteUserBook` → `DELETE /me/v2/books/{id}`).
//
// Content: the web suite's 3-chapter EPUB, uploaded by a fresh user each run.

const API_URL = process.env.API_URL ?? 'http://localhost:8080'
const FIXTURE = path.resolve(__dirname, '../../../web/e2e/fixtures/v2-sync.epub')
const TITLE = 'v2-sync'

async function signIn(request: APIRequestContext) {
  const email = `e2e-mobile-v2-${Date.now()}@textstack.app`
  const login = await request.post(`${API_URL}/auth/test-login`, { data: { email } })
  expect(login.ok(), `test-login: ${login.status()}`).toBeTruthy()
  const { user } = await login.json()
  const cookies = await request.storageState()
  const cookie = (name: string) => cookies.cookies.find((c) => c.name === name)?.value ?? ''
  return { user, accessToken: cookie('access_token'), refreshToken: cookie('refresh_token') }
}

test.describe('V2 sync @v2', () => {
  test.describe.configure({ timeout: 180_000 })

  test('library, book, chapter, resume and vocabulary on /me/v2', async ({ page, playwright }) => {
    const anon = await playwright.request.newContext()
    const session = await signIn(anon)
    const api = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${session.accessToken}` } })
    const v2 = (route: string) => `${API_URL}/me/v2${route}`

    const status = await api.get(v2('/status'))
    test.skip(status.status() === 404 && process.env.V2_E2E !== '1', 'Features:V2Api is off: /me/v2 is not mapped')
    expect(status.ok(), `GET /me/v2/status: ${status.status()}`).toBeTruthy()
    // Past the first-run native-language screen.
    const profile = await api.put(`${API_URL}/me/profile`, { data: { name: null, nativeLanguage: 'uk' } })
    expect(profile.ok(), `profile: ${profile.status()}`).toBeTruthy()
    session.user = (await profile.json()).user

    // Upload by the protocol: sha256 → import → one part → complete.
    const bytes = readFileSync(FIXTURE)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const bookId = randomUUID()
    const fileId = randomUUID()
    const imported = await api.put(v2(`/books/${bookId}`), {
      data: { title: TITLE, file: { id: fileId, sha256, byteSize: bytes.length, originalName: `${TITLE}.epub`, format: 'epub' } },
    })
    expect(imported.status(), await imported.text()).toBe(201)
    expect((await api.put(v2(`/books/${bookId}/files/${fileId}/parts/0`), {
      data: bytes, headers: { 'Content-Type': 'application/octet-stream' },
    })).ok()).toBeTruthy()
    expect((await api.post(v2(`/books/${bookId}/files/${fileId}/content`), { data: { partCount: 1 } })).ok()).toBeTruthy()

    // The worker extracts the chapters (the transitional reader).
    let keys: string[] = []
    await expect.poll(async () => {
      const toc = await (await api.get(v2(`/books/${bookId}/files/${fileId}/chapters`))).json()
      keys = toc.items.map((c: { chapterKey: string }) => c.chapterKey)
      return toc.ingestion
    }, { timeout: 120_000 }).toBe('succeeded')
    expect(keys).toHaveLength(3)

    // The app's session: the web build keeps the mobile tokens in localStorage.
    await page.addInitScript((s) => {
      localStorage.setItem('access_token', s.accessToken)
      localStorage.setItem('refresh_token', s.refreshToken)
      localStorage.setItem('user', JSON.stringify(s.user))
    }, session)

    // Library = the V2 library and reading feeds.
    const libraryFeed = page.waitForResponse((r) => r.url().includes('/me/v2/library/changes') && r.ok())
    await page.goto('/library')
    await libraryFeed
    await expect(page.getByText(TITLE).first()).toBeVisible({ timeout: 30_000 })

    // Resume: another device's place (chapter two) is what the book page offers to continue from,
    // and Continue opens that chapter from the transitional route, by its key.
    const placed = await api.put(v2(`/books/${bookId}/reading-state`), {
      data: {
        expectedRevision: null, fileId, bookFraction: 0.5, clientRecordedAt: new Date().toISOString(),
        currentLocator: { version: 1, scheme: 'textstack-position-v1', value: { v: 1, chapterSlug: keys[1], chapterFraction: 0 } },
      },
    })
    expect(placed.ok(), await placed.text()).toBeTruthy()
    const state = page.waitForResponse((r) => r.url().endsWith(`/me/v2/books/${bookId}/reading-state`) && r.request().method() === 'GET')
    await page.goto(`/my-books/${bookId}`)
    expect((await state).status()).toBe(200)
    await expect(page.getByText('50%').first()).toBeVisible({ timeout: 15_000 })
    const nextChapter = page.waitForResponse((r) => r.url().includes(`/me/v2/books/${bookId}/files/${fileId}/chapters/${keys[1]}`) && r.ok())
    await page.getByText('Continue Reading').click()
    await nextChapter
    await expect(page).toHaveURL(new RegExp(`/my-books/read/${bookId}/${keys[1]}`))

    // A word saved on V2 is in the vocabulary list (the list is the V2 feed).
    const word = await api.put(v2('/vocabulary/words'), {
      data: { id: randomUUID(), language: 'en', word: 'quiver', translation: 'tremble' },
    })
    expect(word.ok(), await word.text()).toBeTruthy()
    const vocabularyFeed = page.waitForResponse((r) => r.url().includes('/me/v2/vocabulary/changes') && r.ok())
    await page.goto('/vocabulary')
    await vocabularyFeed
    await expect(page.getByText('quiver').first()).toBeVisible({ timeout: 15_000 })
  })
})
