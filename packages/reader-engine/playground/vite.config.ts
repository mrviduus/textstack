import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  // web's textAnchor (the probe the engine is checked against) imports shared by its alias.
  resolve: { alias: { '@textstack/shared': resolve(import.meta.dirname, '../../shared/src/index.ts') } },
  server: { port: 5180, strictPort: true, fs: { allow: [resolve(import.meta.dirname, '../../..')] } },
})
