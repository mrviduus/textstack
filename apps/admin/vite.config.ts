import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Deep imports only (`@textstack/shared/lib/x`): the package index pulls
    // in the API client, which admin neither needs nor type-checks cleanly.
    alias: {
      '@textstack/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  server: {
    port: 81,
    host: true,
    allowedHosts: ['textstack.dev', 'localhost', 'admin.localhost'],
    proxy: {
      '/api': {
        target: 'http://api:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  // Local `pnpm preview` only. The container serves dist/ from nginx
  // (apps/admin/Dockerfile + nginx.conf). preview is a separate server config
  // block — `server.*` above does not apply to it.
  preview: {
    port: 81,
    host: true,
    allowedHosts: ['textstack.dev', 'localhost', 'admin.localhost'],
  },
})
