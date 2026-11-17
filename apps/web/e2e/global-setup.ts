import { chromium, type FullConfig } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { testLogin, adminLogin } from './helpers/api'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, '.auth')

async function globalSetup(config: FullConfig) {
  fs.mkdirSync(AUTH_DIR, { recursive: true })

  const browser = await chromium.launch()

  // --- User auth ---
  const userContext = await browser.newContext({ baseURL: config.projects[0].use.baseURL as string })
  const userReq = userContext.request
  await testLogin(userReq)
  await userContext.storageState({ path: path.join(AUTH_DIR, 'user.json') })

  // --- Admin auth (optional — skip if creds not configured) ---
  const adminContext = await browser.newContext()
  try {
    await adminLogin(adminContext.request)
    await adminContext.storageState({ path: path.join(AUTH_DIR, 'admin.json') })
  } catch (e) {
    console.warn('Admin login failed — admin tests will be skipped:', (e as Error).message)
    // Write empty storage state so Playwright doesn't crash
    fs.writeFileSync(path.join(AUTH_DIR, 'admin.json'), JSON.stringify({ cookies: [], origins: [] }))
  }

  await userContext.close()
  await adminContext.close()
  await browser.close()
}

export default globalSetup
