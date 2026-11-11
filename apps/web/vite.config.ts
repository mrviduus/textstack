import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'
import { V2_READER_FRAME_HEADERS, V2_READER_FRAME_PATH, fillNonce, v2ReaderFrameTemplate } from '../mobile/src/lib/v2reader/frame.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The V2 reader frame document (#1219), dev server only: a fresh nonce per response (16 random bytes, hex,
 * as nginx's $request_id) and the frame's own headers. Not emitted to dist/ until the production route.
 */
const v2ReaderFrame = (): Plugin => ({
  name: 'v2-reader-frame',
  apply: 'serve',
  configureServer(server) {
    let template: string | undefined
    server.middlewares.use(V2_READER_FRAME_PATH, (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next()
      template ??= v2ReaderFrameTemplate()
      res.writeHead(200, V2_READER_FRAME_HEADERS)
      res.end(req.method === 'HEAD' ? undefined : fillNonce(template, randomBytes(16).toString('hex')))
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
