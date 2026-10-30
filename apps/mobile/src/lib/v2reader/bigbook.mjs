// The ADR-029 Decision 6 large-book gate: a real EPUB padded to >= <MB> with PNG plates foliate renders (a manifest
// item + an <img> in its own spine section, interleaved from the third original section on), not random bytes. Needs `zip`/`unzip`.
//   node bigbook.mjs <in.epub> <out.epub> [MB=88]   (88 MiB in → ~87 MB out; R4 used Project Gutenberg #28885)
// Write it into fixtures/ (gitignored): the output is ~87 MB and its source book is not in the repo.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

const [src, out, mb = '88'] = process.argv.slice(2)
if (!src || !out) { console.error('usage: node bigbook.mjs <in.epub> <out.epub> [MB]'); process.exit(2) }
const W = 1200, H = 1600

function png(seed) {
  let s = (seed * 2654435761) >>> 0
  const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) >>> 24
  const raw = Buffer.alloc((W * 3 + 1) * H)
  for (let y = 0; y < H; y++) {
    const row = y * (W * 3 + 1)
    for (let x = 0; x < W; x++) {
      const p = row + 1 + x * 3
      // a visible picture (diagonal bands + gradient) with 6 noisy bits so it does not compress away
      const band = ((x + y + seed * 97) >> 6) & 1 ? 128 : 0
      raw[p] = (((x * 128) / W + band) & 0xc0) | (rnd() & 63)
      raw[p + 1] = (((y * 192) / H) & 0xc0) | (rnd() & 63)
      raw[p + 2] = ((seed * 37 + band) & 0xc0) | (rnd() & 63)
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))])
}

const dir = mkdtempSync(resolve(tmpdir(), 'bigbook-'))
execFileSync('unzip', ['-q', resolve(src), '-d', dir])
const opfPath = join(dir, /full-path="([^"]+)"/.exec(readFileSync(join(dir, 'META-INF/container.xml'), 'utf8'))[1])
let opf = readFileSync(opfPath, 'utf8')
const original = [...opf.matchAll(/<itemref\b[^>]*\/>/g)].length
const target = Number(mb) * 1024 * 1024
let total = statSync(resolve(src)).size, n = 0, manifest = ''
const pads = []
while (total < target * 1.02) {
  n++
  const img = png(n)
  writeFileSync(join(dirname(opfPath), `pad-${n}.png`), img)
  writeFileSync(join(dirname(opfPath), `pad-${n}.xhtml`), `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Plate ${n}</title></head><body><h2>Plate ${n}</h2><p>Generated plate ${n} of the 80 MB gate book.</p><p><img src="pad-${n}.png" alt="plate ${n}" style="max-width:100%"/></p></body></html>`)
  manifest += `<item id="pad-img-${n}" href="pad-${n}.png" media-type="image/png"/><item id="pad-${n}" href="pad-${n}.xhtml" media-type="application/xhtml+xml"/>`
  pads.push(`<itemref idref="pad-${n}"/>`)
  total += img.length
}
opf = opf.replace('</manifest>', `${manifest}</manifest>`)
// interleave: one plate after each original section from the 3rd on, the rest at the end
let k = 0
opf = opf.replace(/<itemref\b[^>]*\/>/g, (m) => (k++ >= 2 && pads.length ? m + pads.shift() : m))
opf = opf.replace('</spine>', `${pads.join('')}</spine>`)
writeFileSync(opfPath, opf)
rmSync(resolve(out), { force: true })
execFileSync('zip', ['-X0q', resolve(out), 'mimetype'], { cwd: dir })
execFileSync('zip', ['-Xr9Dq', resolve(out), ...readdirSync(dir).filter((f) => f !== 'mimetype')], { cwd: dir })
rmSync(dir, { recursive: true })
console.log(`${out}: ${statSync(resolve(out)).size} bytes, ${n} plates ${W}x${H}, ${original} original sections`)
