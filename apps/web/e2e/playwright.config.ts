import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.BASE_URL ?? 'http://localhost:5173'
const apiURL = process.env.API_URL ?? 'http://localhost:8080'
const isCI = !!process.env.CI

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 3 : undefined,
  reporter: isCI ? [['list'], ['html', { outputFolder: 'playwright-report' }]] : [['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',

  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /.*mobile.*/,
    },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        // Use chromium instead of webkit to avoid extra browser install
        browserName: 'chromium',
      },
      testMatch: /.*mobile.*/,
    },
  ],

  webServer: [
    {
      // CI builds once in its own step (ci.yml e2e "Build web app"); every run serves that dist.
      command: isCI ? 'pnpm preview --port 5173' : 'pnpm dev',
      url: baseURL,
      reuseExistingServer: !isCI,
    },
  ],
})

export { apiURL, baseURL }
