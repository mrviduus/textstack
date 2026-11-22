import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'
import { READER_DIR, READER_FRAME_PATH } from '../../packages/reader/src/framePath.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The V2 reader frame (#1219, #1225): a no-store shell + the content-hashed page script, under /reader/.
 * Both servers answer it with frame.mjs `serveReaderFrame` (the handler prodCsp.check.mjs tests; it fills a
 * fresh nonce per response, as nginx does in production): the dev server from source, `vite preview` from the
 * built dist/reader/ (CI's e2e then runs the bytes nginx ships). A build writes the two files there.
 * frame.mjs carries the 3.75 MB page: imported on the first reader request or at the end of a build, never
 * into the app's own chunks (scripts/assert-no-dev-reader.mjs).
 */
const loadFrame = () => import('../../packages/reader/src/frame.mjs')
type FrameModule = Awaited<ReturnType<typeof loadFrame>>
/** `files`: null for the source's; else the build's, read once. */
const serveFrame = (files: ((m: FrameModule) => object) | null): Connect.NextHandleFunction => {
  let built: object | undefined
  return (req, res, next) => {
    if (!req.url?.startsWith(READER_DIR)) return next()
    loadFrame().then((m) => m.serveReaderFrame(req, res, files ? (built ??= files(m)) : undefined) || next()).catch(next)
  }
}
const readerFrame = (): Plugin => ({
  name: 'reader-frame',
  configureServer: (server) => { server.middlewares.use(serveFrame(null)) },
  configurePreviewServer: (server) => {
    const dist = path.resolve(server.config.root, server.config.build.outDir)
    server.middlewares.use(serveFrame((m) => m.readerDistFiles(dist)))
  },
  async generateBundle() {
    const { readerFrameFiles } = await loadFrame()
    const { shell, script, scriptPath } = readerFrameFiles()
    this.emitFile({ type: 'asset', fileName: READER_FRAME_PATH.slice(1), source: shell })
    this.emitFile({ type: 'asset', fileName: scriptPath.slice(1), source: script })
  },
})

export default defineConfig({
  plugins: [react(), readerFrame()],
  resolve: {
    alias: {
      '@textstack/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      // Before the bare name: an alias matches by prefix. The PDF layout, loaded lazily with pdf.js (Phase 5).
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
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
