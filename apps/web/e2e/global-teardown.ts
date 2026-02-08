import type { FullConfig } from '@playwright/test'

async function globalTeardown(_config: FullConfig) {
  // Cleanup is intentionally light — test data can be reused across runs.
  // Delete .auth/ and .test-data.json manually if you want a fresh state.
  console.log('E2E teardown complete')
}

export default globalTeardown
