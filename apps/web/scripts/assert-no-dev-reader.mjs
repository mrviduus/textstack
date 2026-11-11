// Fails the production build if the V2 reader is in dist/ other than as the production route ships it (#1225):
//   - dist/reader-v2/ holds exactly the frame shell (frame.html) and one content-hashed page script, and the
//     shell names that script with its SHA-384 and carries the unfilled nonce placeholder (nginx fills it per
//     response; an unfilled shell runs nothing), never the page's own placeholder or page code;
//   - no other file carries the dev route (R5, #1037: main.tsx keeps it behind import.meta.env.DEV) or the
//     3.75 MB page code: the app's chunks only name /reader-v2/frame.html.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { V2_READER_DIR, V2_READER_FRAME_PATH, V2_READER_SCRIPT_PATH } from '../../mobile/src/lib/v2reader/framePath.mjs'

const PLACEHOLDER = '%V2_READER_FRAME_NONCE%' // frame.mjs FRAME_NONCE_PLACEHOLDER (not imported: it loads the page)
// The page's own nonce placeholder and its format readers (page code); the dev page (its file input, its route).
const LEAK = /__V2_READER_NONCE__|__TS_FORMATS|V2ReaderDevPage|Pick EPUB|\\?\/dev\\?\/reader-v2/
const dist = new URL('../dist', import.meta.url).pathname
const readerDir = V2_READER_DIR.slice(1, -1) // 'reader-v2'
const problems = []

for (const f of readdirSync(dist, { recursive: true })) {
  if (f.startsWith(`${readerDir}/`) || !/\.(js|html)$/.test(f)) continue
  if (LEAK.test(readFileSync(join(dist, f), 'utf8'))) problems.push(`${f}: carries the dev route or the page code`)
}

const dir = join(dist, readerDir)
const files = existsSync(dir) ? readdirSync(dir, { recursive: true }).sort() : []
const scripts = files.filter((f) => V2_READER_SCRIPT_PATH.test(`${V2_READER_DIR}${f}`))
if (files.length !== 2 || !files.includes('frame.html') || scripts.length !== 1)
  problems.push(`${readerDir}/ must hold frame.html and one page.<hash>.js, holds: [${files.join(', ')}]`)
else {
  const shell = readFileSync(join(dist, V2_READER_FRAME_PATH), 'utf8')
  const script = readFileSync(join(dir, scripts[0]))
  const sha = createHash('sha384').update(script).digest()
  if (shell.split(PLACEHOLDER).length - 1 !== 3) problems.push(`frame.html: the nonce placeholder must be in its CSP and both scripts`)
  if (LEAK.test(shell)) problems.push('frame.html: carries the page code or the page\'s own placeholder')
  if (`page.${sha.toString('hex').slice(0, 16)}.js` !== scripts[0]) problems.push(`${scripts[0]}: its name is not its content hash`)
  if (!shell.includes(`src="${V2_READER_DIR}${scripts[0]}" integrity="sha384-${sha.toString('base64')}"`))
    problems.push(`frame.html: does not load ${scripts[0]} with its integrity`)
}

if (problems.length) {
  console.error(`[assert-no-dev-reader] the V2 reader in dist/ is not what the production route ships:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`[assert-no-dev-reader] dist/ has no dev route; ${readerDir}/ = frame.html + ${scripts[0]}.`)
