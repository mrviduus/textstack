#!/usr/bin/env node
// The shell serves the reader frame itself (ReaderFrameClient.java), where nginx does it on the web. This check
// holds the Java side equal to packages/reader/src/frame.mjs: the path, the nonce placeholder, every frame
// header. Content-Type is not in the Java map: WebResourceResponse takes the type and the encoding as arguments.
import { readFileSync } from 'node:fs'
import { FRAME_NONCE_PLACEHOLDER, READER_FRAME_HEADERS, READER_FRAME_PATH } from '../../../packages/reader/src/frame.mjs'

const java = readFileSync(new URL('../android/app/src/main/java/app/textstack/mobile/ReaderFrameClient.java', import.meta.url), 'utf8')
const problems = []
const need = (text, what) => { if (!java.includes(text)) problems.push(`${what}: ${text}`) }

need(`FRAME_PATH = "${READER_FRAME_PATH}"`, 'frame path')
need(`NONCE_PLACEHOLDER = "${FRAME_NONCE_PLACEHOLDER}"`, 'nonce placeholder')
const { 'Content-Type': type, ...headers } = READER_FRAME_HEADERS
if (type !== 'text/html; charset=utf-8') problems.push(`frame.mjs Content-Type changed: ${type}`)
need('"text/html", "utf-8"', 'content type')
for (const [k, v] of Object.entries(headers)) need(`h.put("${k}", "${v}");`, 'header')
const puts = java.match(/h\.put\(/g)?.length ?? 0
if (puts !== Object.keys(headers).length) problems.push(`the Java map has ${puts} headers, frame.mjs has ${Object.keys(headers).length}`)

if (problems.length) {
  console.error(`[check-reader-frame] ReaderFrameClient.java differs from frame.mjs:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`[check-reader-frame] ReaderFrameClient.java sends the frame as frame.mjs does (${puts} headers).`)
