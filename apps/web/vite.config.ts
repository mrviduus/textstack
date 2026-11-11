import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import { V2_READER_DIR, V2_READER_FRAME_PATH } from '../mobile/src/lib/v2reader/framePath.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The V2 reader frame (#1219, #1225): a no-store shell + the content-hashed page script, under /reader-v2/.
 * Dev and preview servers answer it with frame.mjs `serveV2ReaderFrame` (the handler prodCsp.check.mjs tests;
 * it fills a fresh nonce per response, as nginx does in production); a build writes the same two files into
 * dist/reader-v2/ for nginx. frame.mjs carries the 3.75 MB page: imported on the first reader request or at
 * the end of a build, never into the app's own chunks (scripts/assert-no-dev-reader.mjs).
 */
const loadFrame = () => import('../mobile/src/lib/v2reader/frame.mjs')
const serveFrame: Connect.NextHandleFunction = (req, res, next) => {
  if (!req.url?.startsWith(V2_READER_DIR)) return next()
  loadFrame().then(({ serveV2ReaderFrame }) => serveV2ReaderFrame(req, res) || next()).catch(next)
}
const v2ReaderFrame = (): Plugin => ({
  name: 'v2-reader-frame',
  configureServer: (server) => { server.middlewares.use(serveFrame) },
  configurePreviewServer: (server) => { server.middlewares.use(serveFrame) },
  async generateBundle() {
    const { v2ReaderFrameFiles } = await loadFrame()
    const { shell, script, scriptPath } = v2ReaderFrameFiles()
    this.emitFile({ type: 'asset', fileName: V2_READER_FRAME_PATH.slice(1), source: shell })
    this.emitFile({ type: 'asset', fileName: scriptPath.slice(1), source: script })
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
