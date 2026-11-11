import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import { V2_READER_FRAME_PATH } from '../mobile/src/lib/v2reader/framePath.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The V2 reader frame document (#1219), dev server only, served by frame.mjs `serveV2ReaderFrame` (the
 * handler prodCsp.check.mjs tests). frame.mjs carries the 3.75 MB page: imported on the first frame request,
 * so a build (and every other dev request) never evaluates it. Not emitted to dist/ until the production route.
 */
const v2ReaderFrame = (): Plugin => ({
  name: 'v2-reader-frame',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith(V2_READER_FRAME_PATH)) return next()
      import('../mobile/src/lib/v2reader/frame.mjs')
        .then(({ serveV2ReaderFrame }) => serveV2ReaderFrame(req, res) || next())
        .catch(next)
    })
  },
})

export default defineConfig({
  plugins: [react(), v2ReaderFrame()],
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
