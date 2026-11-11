// Scratch config for the v2-reader-dev suite only: no globalSetup (local /auth/test-login is broken,
// see wave-10 prompt), dev server expected on :5173. Not committed.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/tests',
  testMatch: 'v2-reader-dev.spec.ts',
  use: { baseURL: 'http://localhost:5173' },
})
