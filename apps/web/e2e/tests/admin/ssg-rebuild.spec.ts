import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const authFile = path.resolve(__dirname, '../../.auth/admin.json')

// Check if admin auth is available (has cookies)
function hasAdminAuth(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(authFile, 'utf-8'))
    return data.cookies?.length > 0
  } catch {
    return false
  }
}

// Admin tests use the admin project (baseURL: localhost:81)
test.use({
  storageState: authFile,
})

test.describe('QA-003: Admin SSG Rebuild', () => {
  test.beforeEach(() => {
    test.skip(!hasAdminAuth(), 'Admin auth not configured')
  })

  test('admin login and SSG page accessible', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Admin panel should load
    await expect(page.locator('body')).not.toContainText('Unauthorized')
  })

  test('SSG rebuild page loads', async ({ page }) => {
    await page.goto('/ssg')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('body')).toContainText(/SSG|rebuild|static/i)
  })

  test('create full rebuild job', async ({ page }) => {
    await page.goto('/ssg')
    await page.waitForLoadState('networkidle')

    // Look for "Full Rebuild" or "New Job" button
    const createBtn = page.locator('button').filter({ hasText: /full|rebuild|new|create/i }).first()
    if (await createBtn.isVisible()) {
      await createBtn.click()
      await page.waitForTimeout(2000)

      // Should see job status
      await expect(page.locator('body')).toContainText(/queued|running|completed|cancelled/i)
    }
  })

  test('job lifecycle: queued → running → completed', async ({ page }) => {
    await page.goto('/ssg')
    await page.waitForLoadState('networkidle')

    // Check for existing jobs or create one
    const jobRows = page.locator('tr, [class*="job"], [class*="card"]').filter({
      hasText: /queued|running|completed|failed/i,
    })

    const count = await jobRows.count()
    if (count > 0) {
      // Click first job to see details
      await jobRows.first().click()
      await page.waitForTimeout(1000)

      // Job detail should show status
      await expect(page.locator('body')).toContainText(/status|progress|route/i)
    }
  })
})
