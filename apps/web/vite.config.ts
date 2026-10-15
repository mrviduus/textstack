import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@textstack/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      // Before the bare name: an alias matches by prefix. The PDF layout, loaded lazily with pdf.js (Phase 5).
      '@textstack/reader-engine/fixed': path.resolve(__dirname, '../../packages/reader-engine/src/fixed.ts'),
      '@textstack/reader-engine': path.resolve(__dirname, '../../packages/reader-engine/src/index.ts'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'charts': ['recharts'],
          'sanitize': ['dompurify'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    // Allow prerender container to access via Docker network name
    allowedHosts: ['web', 'localhost', 'general.localhost'],
    // Proxy API requests to API container (needed for prerender)
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
        headers: {
          Host: 'general.localhost',
        },
      },
      '/me': {
        target: 'http://localhost:8080',
        changeOrigin: false,
        headers: {
          Host: 'general.localhost',
        },
      },
      '/books': {
        target: 'http://localhost:8080',
        changeOrigin: false,
        headers: {
          Host: 'general.localhost',
        },
      },
      '/storage': {
        target: 'http://localhost:8080',
        changeOrigin: false,
        headers: {
          Host: 'general.localhost',
        },
      },
    },
  },
})
