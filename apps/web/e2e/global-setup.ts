import { chromium, type FullConfig } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { testLogin } from './helpers/api'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = path.resolve(__dirname, '.auth')

async function globalSetup(config: FullConfig) {
  fs.mkdirSync(AUTH_DIR, { recursive: true })

  const browser = await chromium.launch()

  // --- User auth ---
  const userContext = await browser.newContext({ baseURL: config.projects[0].use.baseURL as string })
  await testLogin(userContext.request)
  await userContext.storageState({ path: path.join(AUTH_DIR, 'user.json') })

  await userContext.close()
  await browser.close()
}

export default globalSetup
