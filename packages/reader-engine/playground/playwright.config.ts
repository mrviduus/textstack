import { defineConfig, devices } from '@playwright/test'

// The engine's geometry on real chapters (phase 2 slice 7): a phone-sized Chromium, the playground page.
export default defineConfig({
  testDir: '.',
  testMatch: '*.e2e.ts',
  retries: 0,
  use: { ...devices['Pixel 7'], baseURL: 'http://localhost:5180' },
  webServer: {
    command: 'vite',   // cwd: this directory, so vite.config.ts here
    url: 'http://localhost:5180',
    reuseExistingServer: !process.env.CI,
  },
})
