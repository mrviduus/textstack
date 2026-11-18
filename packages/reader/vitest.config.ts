import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@textstack/shared': resolve(__dirname, '../shared/src/index.ts') } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
