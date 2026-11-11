// The recipe for the SYNTHETIC KF8 fixtures in synthetic/ (#1182). Calibre is not in CI, so the outputs are
// committed and this script is how they were made; formats.test.ts checks the committed bytes against SYNTHETIC.
// Synthetic: they do not establish compatibility with real-world Kindle books.
//
//   node kf8fixture.mjs <outDir>   → <outDir>/tssynthetic-src.epub, tssynthetic-kf8.azw3, tssynthetic-combo.mobi,
//                                    tshostile-kf8.azw3
//
// All text below is original, written for this repository; no third-party content. Needs `zip` and Calibre's
// `ebook-convert` (recorded: calibre 9.18.0, macOS).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { png, writeHostileEpub, zipEpub } from './fixtures.mjs'

/** The committed files: SHA-256 and size. Regenerating on purpose means updating these and synthetic/README.md. */
export const SYNTHETIC = {
  'tssynthetic-src.epub': ['0cf5aa7d88be956cafe7cb89feac764ef0c931c7835099128a6735f58641cb94', 3471],
  'tssynthetic-kf8.azw3': ['3729892f5b92657d111e584754aa86435b5b0b3f9d0df09702036495d92444d9', 23993],
  'tssynthetic-combo.mobi': ['0dbb3e25f6a8a3e9b31c6fc9c2f93d513bd211ff4d7deab5d8a3b7db323b00e8', 52497],
  'tshostile-kf8.azw3': ['a7d90fdae600e2c411dc274849cfaf9ac9e9882b4921d3420ee1771ecb15470a', 17967],
}

/**
 * The hostile KF8: fixtures.mjs' hostile EPUB, converted, with these addresses in place of the evil server and
 * the sibling directory. sandbox.check.mjs swaps them for its own, byte for byte: each the same length (a
 * 5-digit port; a sibling directory padded to 200 characters), so every record offset stays valid. Uncompressed
 * (`--dont-compress`), or the addresses could not be found. `count`: how many times each is in the file.
 */
export const HOSTILE_KF8 = {
  evil: 'http://127.0.0.1:65535',
  siblings: `file:///ts-hostile-kf8-siblings-${'x'.repeat(168)}`,
  count: { evil: 16, siblings: 3 },
}

const UUID = '6f0c1e7a-2b3d-4c5e-8f90-a1b2c3d4e5f6'
const DATE = '2026-01-01T00:00:00+00:00'
const xhtml = (title, head, body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><link rel="stylesheet" type="text/css" href="style.css"/>${head}</head><body>${body}</body></html>`
const p = (n, s) => Array.from({ length: n }, (_, i) => `<p>${s} Line ${i + 1}.</p>`).join('')

export function writeSource(out) {
  const dir = mkdtempSync(resolve(tmpdir(), 'tskf8src-'))
  const put = (f, d) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), d) }
  put('mimetype', 'application/epub+zip')
  put('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  put('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:identifier id="uid" opf:scheme="uuid">${UUID}</dc:identifier><dc:title>TS Synthetic KF8</dc:title><dc:creator>TextStack Fixture</dc:creator><dc:language>en</dc:language><dc:date>${DATE}</dc:date></metadata>
<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/><item id="img" href="plate.png" media-type="image/png"/><item id="svg" href="badge.svg" media-type="image/svg+xml"/>
<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/><item id="s2" href="s2.xhtml" media-type="application/xhtml+xml"/><item id="s3" href="s3.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine toc="ncx"><itemref idref="s1"/><itemref idref="s2"/><itemref idref="s3"/></spine></package>`)
  put('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${UUID}"/></head><docTitle><text>TS Synthetic KF8</text></docTitle><navMap>
${['One', 'Two', 'Three'].map((t, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>Part ${t}</text></navLabel><content src="s${i + 1}.xhtml"/></navPoint>`).join('')}</navMap></ncx>`)
  // Distinctive, measurable rules: the check reads computed colours/width to prove the CSS applied.
  put('OEBPS/style.css', 'p.mark { color: rgb(10, 120, 30); } h1.title { color: rgb(200, 20, 20); } img.plate { width: 120px; }')
  put('OEBPS/plate.png', png(120, 60, [40, 90, 200]))
  put('OEBPS/badge.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#c84"/></svg>')
  put('OEBPS/s1.xhtml', xhtml('Part One', '', `<h1 class="title">Part One</h1><p class="mark">Kestrel lanterns hum over the quiet canal.</p><p><img class="plate" src="plate.png" alt="plate"/></p><p><img class="badge" src="badge.svg" alt="badge"/></p><p><a href="s3.xhtml#harbour">Go to the harbour</a></p>${p(40, 'Part one filler, written for this fixture.')}`))
  put('OEBPS/s2.xhtml', xhtml('Part Two', '<meta http-equiv="refresh" content="0; url=s1.xhtml"/>', `<h1 class="title">Part Two</h1><p class="mark">Copper gulls argue with the tide clock.</p>${p(40, 'Part two filler, written for this fixture.')}`))
  put('OEBPS/s3.xhtml', xhtml('Part Three', '', `<h1 class="title">Part Three</h1>${p(30, 'Part three filler, written for this fixture.')}<p id="harbour" class="mark">The harbour keeps its lamps lit until the last ferry docks.</p>${p(10, 'Part three tail, written for this fixture.')}`))
  // Fixed mtimes: zip records them.
  const walk = (d) => { for (const f of readdirSync(d)) { const x = join(d, f); if (statSync(x).isDirectory()) walk(x); utimesSync(x, 1767225600, 1767225600) } }
  walk(dir)
  zipEpub(dir, out)
  rmSync(dir, { recursive: true })
  return out
}

/** The exact ebook-convert options used; fixed metadata so the tool has as little to invent as it allows. */
export const convertArgs = (src, out, fileType, title = 'TS Synthetic KF8') => [src, out,
  '--title', title, '--authors', 'TextStack Fixture', '--language', 'en',
  '--pubdate', DATE, '--timestamp', DATE, '--book-producer', 'TextStack fixture',
  '--no-inline-toc', '--dont-compress',
  ...(fileType ? ['--mobi-file-type', fileType] : [])]

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = resolve(process.argv[2] ?? 'synthetic')
  mkdirSync(outDir, { recursive: true })
  const src = writeSource(join(outDir, 'tssynthetic-src.epub'))
  const env = { ...process.env, SOURCE_DATE_EPOCH: '1767225600', TZ: 'UTC' }
  const convert = (from, name, type, title) => {
    execFileSync('ebook-convert', convertArgs(from, join(outDir, name), type, title), { stdio: 'ignore', env })
    writeFileSync(join(outDir, name), normalise(readFileSync(join(outDir, name))))
  }
  convert(src, 'tssynthetic-kf8.azw3')
  convert(src, 'tssynthetic-combo.mobi', 'both')
  // The hostile source is not kept: fixtures.mjs writes it again, the same, from the same addresses.
  const hostile = join(mkdtempSync(resolve(tmpdir(), 'tskf8hostile-')), 'tshostile.epub')
  convert(writeHostileEpub(hostile, HOSTILE_KF8.siblings, HOSTILE_KF8.evil), 'tshostile-kf8.azw3', undefined, 'tshostile')
  rmSync(dirname(hostile), { recursive: true })
}

/**
 * Calibre 9.18 writes three values per run that no option pins: the PDB creation/modification times (now),
 * the MOBI header unique id (random) and a fresh book UUID in EXTH 112 ("calibre:<uuid>") and 113. They are
 * overwritten with fixed values, in record 0 and in a combo's KF8 header (EXTH 121), lengths unchanged.
 */
export function normalise(buf) {
  const u32 = (i) => buf.readUInt32BE(i)
  buf.writeUInt32BE(1767225600, 36)
  buf.writeUInt32BE(1767225600, 40)
  const rec = (i) => u32(78 + i * 8)
  const fix = (r0) => {
    buf.writeUInt32BE(0x15f1ce, r0 + 32)
    if (!(u32(r0 + 128) & 0x40)) return null
    let p = r0 + 16 + u32(r0 + 20)
    const count = u32(p + 8)
    let kf8 = null
    p += 12
    for (let i = 0; i < count; i++) {
      const type = u32(p), len = u32(p + 4)
      if (type === 112 || type === 113) {
        const s = buf.toString('latin1', p + 8, p + len)
        buf.write(s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, UUID), p + 8, 'latin1')
      }
      if (type === 121) kf8 = u32(p + 8)
      p += len
    }
    return kf8
  }
  const kf8 = fix(rec(0))
  if (kf8 !== null && kf8 < buf.readUInt16BE(76)) fix(rec(kf8))
  return buf
}
