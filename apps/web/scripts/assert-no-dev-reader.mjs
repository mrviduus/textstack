// Fails the production build if the V2 reader dev route (R5, #1037) leaked into dist/: main.tsx keeps it
// behind import.meta.env.DEV, and this is the check that the gate still holds.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const LEAK = /__V2_READER_NONCE__|v2reader:|reader-v2|V2ReaderDevPage/
const dist = new URL('../dist', import.meta.url).pathname
const leaked = readdirSync(dist, { recursive: true }).filter((f) => /\.(js|html)$/.test(f) && LEAK.test(readFileSync(join(dist, f), 'utf8')))

if (leaked.length) {
  console.error(`[assert-no-dev-reader] the V2 reader dev route is in the production build:\n  ${leaked.join('\n  ')}`)
  process.exit(1)
}
console.log('[assert-no-dev-reader] dist/ has no V2 reader dev route.')
