// The ADR-029 Decision 6 large-book gate: a real EPUB padded with PNG plates foliate renders (a manifest item + an <img>
// in its own spine section, interleaved from the third original section on), not random bytes. Needs `zip`/`unzip`.
//   node bigbook.mjs <in.epub> <out.epub> [MB=88]   pads until the raw plates reach ~MB MiB (+2 %); the real size is printed.
// Each plate is ~0.85 MB: NOISE_ROWS sets how often its noise is fresh (88 → ~100 plates, the gate's measured shape).
// Write it into fixtures/ (gitignored): the output is large and its source book is not in the repo.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join, sep } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { zipEpub } from './fixtures.mjs'

const [src, out, mb = '88'] = process.argv.slice(2)
if (!src || !out || !(Number(mb) > 0)) { console.error('usage: node bigbook.mjs <in.epub> <out.epub> [MB=88]'); process.exit(2) }
const W = 1200, H = 1600
// Fresh noise every NOISE_ROWS rows, repeated between: the knob for a plate's compressed size (8 → ~0.85 MB).
const NOISE_ROWS = 8

function png(seed) {
  let s = (seed * 2654435761) >>> 0
  // Math.imul: a plain multiply passes 2^53, loses the low bits and cycles after ~419 steps (plates compress 9×).
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24
  const raw = Buffer.alloc((W * 3 + 1) * H)
  let rowSeed = 0
  for (let y = 0; y < H; y++) {
    if (y % NOISE_ROWS === 0) rowSeed = s; else s = rowSeed
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
/** `text.replace`, failing loud when nothing matched (a prefixed OPF such as `</opf:manifest>`). */
const replaced = (text, what, by) => {
  const next = text.replace(what, by)
  if (next === text) throw new Error(`bigbook: no ${what} in the OPF`)
  return next
}
// A self-closing <itemref/> or an empty <itemref …></itemref>.
const ITEMREF = /<itemref\b[^>]*?(?:\/>|>\s*<\/itemref>)/g
try {
  execFileSync('unzip', ['-q', resolve(src), '-d', dir])
  // The EPUB is untrusted: a symlink would redirect plate writes or let `zip -r` pull local files into the output.
  // (unzip has no flag that refuses symlinks; it restores them.)
  // Own walk: readdirSync's `recursive` descends into symlinked directories.
  const noLinks = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw new Error(`bigbook: symlink in the EPUB: ${join(d, e.name)}`)
    if (e.isDirectory()) noLinks(join(d, e.name))
  } }
  noLinks(dir)
  const fullPath = /full-path=["']([^"']+)["']/.exec(readFileSync(join(dir, 'META-INF/container.xml'), 'utf8'))
  if (!fullPath) throw new Error('bigbook: no full-path in META-INF/container.xml')
  const opfPath = resolve(dir, fullPath[1])
  if (!opfPath.startsWith(resolve(dir) + sep)) throw new Error(`bigbook: full-path outside the book: ${fullPath[1]}`)
  let opf = readFileSync(opfPath, 'utf8')
  const original = [...opf.matchAll(ITEMREF)].length
  if (!original) throw new Error('bigbook: no <itemref> in the OPF')
  const target = Number(mb) * 1024 * 1024
  let total = statSync(resolve(src)).size, manifest = ''
  const pads = []
  let n = 0
  while (total < target * 1.02) {
    n++
    const img = png(n)
    writeFileSync(join(dirname(opfPath), `pad-${n}.png`), img)
    writeFileSync(join(dirname(opfPath), `pad-${n}.xhtml`), `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Plate ${n}</title></head><body><h2>Plate ${n}</h2><p>Generated plate ${n}.</p><p><img src="pad-${n}.png" alt="plate ${n}" style="max-width:100%"/></p></body></html>`)
    manifest += `<item id="pad-img-${n}" href="pad-${n}.png" media-type="image/png"/><item id="pad-${n}" href="pad-${n}.xhtml" media-type="application/xhtml+xml"/>`
    pads.push(`<itemref idref="pad-${n}"/>`)
    total += img.length
  }
  opf = replaced(opf, '</manifest>', `${manifest}</manifest>`)
  // interleave: one plate after each original section from the 3rd on, the rest at the end
  let k = 0
  opf = opf.replace(ITEMREF, (m) => (k++ >= 2 && pads.length ? m + pads.shift() : m))
  opf = replaced(opf, '</spine>', `${pads.join('')}</spine>`)
  writeFileSync(opfPath, opf)
  zipEpub(dir, resolve(out))
  console.log(`${out}: ${statSync(resolve(out)).size} bytes, ${n} plates ${W}x${H}, ${original + n} sections (${original} original)`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
