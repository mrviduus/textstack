import { chromium, type FullConfig } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { testLogin, adminLogin } from './helpers/api'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API_URL = process.env.API_URL ?? 'http://localhost:8080'
const AUTH_DIR = path.resolve(__dirname, '.auth')
const TEST_DATA_PATH = path.resolve(__dirname, '.test-data.json')

async function globalSetup(config: FullConfig) {
  fs.mkdirSync(AUTH_DIR, { recursive: true })

  const browser = await chromium.launch()

  // --- User auth ---
  const userContext = await browser.newContext({ baseURL: config.projects[0].use.baseURL as string })
  const userReq = userContext.request
  await testLogin(userReq)
  await userContext.storageState({ path: path.join(AUTH_DIR, 'user.json') })

  // --- Admin auth (optional — skip if creds not configured) ---
  let adminReq: any = null
  const adminContext = await browser.newContext()
  try {
    await adminLogin(adminContext.request)
    adminReq = adminContext.request
    await adminContext.storageState({ path: path.join(AUTH_DIR, 'admin.json') })
  } catch (e) {
    console.warn('Admin login failed — admin tests will be skipped:', (e as Error).message)
    // Write empty storage state so Playwright doesn't crash
    fs.writeFileSync(path.join(AUTH_DIR, 'admin.json'), JSON.stringify({ cookies: [], origins: [] }))
  }

  // --- Upload test books (if not already present) ---
  const existingData = loadTestData()
  if (existingData) {
    console.log('Test data already exists, skipping upload')
  } else {
    console.log('Discovering test books...')
    await seedTestData(adminReq ?? userReq)
  }

  await userContext.close()
  await adminContext.close()
  await browser.close()
}

async function seedTestData(request: any) {
  // Discover existing books from the API
  const booksResp = await request.get(`${API_URL}/books?limit=20`, {
    headers: { Host: 'general.localhost' },
  })
  if (!booksResp.ok()) {
    console.warn('Could not fetch books:', booksResp.status())
    // Write minimal test data so tests can still run (will skip book-dependent tests)
    fs.writeFileSync(TEST_DATA_PATH, JSON.stringify({ siteId: '' }))
    return
  }

  const books = await booksResp.json()
  const items = books?.items ?? []

  const enBook = items.find((b: any) => b.language === 'en')
  const ukBook = items.find((b: any) => b.language === 'uk') ?? items.find((b: any) => b.language !== 'en')

  const testData: any = { siteId: '' }
  if (enBook) {
    const detail = await fetchBookDetail(request, enBook.slug)
    testData.enBook = {
      editionId: enBook.id,
      slug: enBook.slug,
      title: enBook.title,
      chapterCount: enBook.chapterCount ?? 3,
      firstChapterSlug: detail?.chapters?.[0]?.slug ?? '',
      secondChapterSlug: detail?.chapters?.[1]?.slug ?? '',
    }
  }
  if (ukBook) {
    const detail = await fetchBookDetail(request, ukBook.slug)
    testData.ukBook = {
      editionId: ukBook.id,
      slug: ukBook.slug,
      title: ukBook.title,
      chapterCount: ukBook.chapterCount ?? 3,
      firstChapterSlug: detail?.chapters?.[0]?.slug ?? '',
      secondChapterSlug: detail?.chapters?.[1]?.slug ?? '',
    }
  }

  fs.writeFileSync(TEST_DATA_PATH, JSON.stringify(testData, null, 2))
  console.log('Discovered test books:', testData)
}

async function fetchBookDetail(request: any, slug: string) {
  try {
    const resp = await request.get(`${API_URL}/books/${slug}`, {
      headers: { Host: 'general.localhost' },
    })
    if (resp.ok()) return resp.json()
  } catch {}
  return null
}

function loadTestData() {
  if (!fs.existsSync(TEST_DATA_PATH)) return null
  try {
    return JSON.parse(fs.readFileSync(TEST_DATA_PATH, 'utf-8'))
  } catch {
    return null
  }
}

export default globalSetup
