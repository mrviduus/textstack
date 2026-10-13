import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@textstack/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      '@textstack/reader-overlay': path.resolve(__dirname, '../../packages/reader-overlay/src/index.ts'),
      '@textstack/reader-engine': path.resolve(__dirname, '../../packages/reader-engine/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
})
