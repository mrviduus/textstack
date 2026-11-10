// Crafted books for the gates no Project Gutenberg book covers (ADR-029 Decision 6), into the gitignored
// fixtures/; needs the `zip` CLI.   node fixtures.mjs [siblingDir]   → fixtures/tsfonts.epub, fixtures/tshostile.epub,
// and one small book per other format (writeFormatFixtures)
// tsfonts: one font (Source Sans 3, OFL) plain, IDPF- and Adobe-obfuscated. tshostile: see hostileVectors.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { crc32, deflateSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// The on-device run's logging server (`adb reverse tcp:9876 tcp:9876`); sandbox.check.mjs passes its own.
export const EVIL = 'http://127.0.0.1:9876'
// The app's own private files: the dev route's page origin is file:// on Android (README.md).
const LOCAL = 'file:///data/user/0/app.textstack.mobile/files'
const UUID = '2c4a3b8e-5d1f-4e6a-9b7c-0123456789ab'

function epub(out, name, { files, manifest, spine, encryption }) {
  const dir = mkdtempSync(resolve(tmpdir(), 'tsepub-'))
  const put = (p, data) => { mkdirSync(dirname(resolve(dir, p)), { recursive: true }); writeFileSync(resolve(dir, p), data) }
  put('mimetype', 'application/epub+zip')
  put('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
  if (encryption) put('META-INF/encryption.xml', `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">${encryption.map(([alg, uri]) =>
    `<enc:EncryptedData><enc:EncryptionMethod Algorithm="${alg}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData>`).join('')}</encryption>`)
  put('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:${UUID}</dc:identifier><dc:title>${name}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-10-29T00:00:00Z</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${manifest}</manifest><spine>${spine}</spine></package>`)
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

const fixtures = resolve(here, 'fixtures')

// OCF obfuscation: XOR the first 1040 (IDPF, key = SHA-1 of the identifier) or 1024 (Adobe, key = UUID bytes) bytes.
const xor = (buf, key, n) => Buffer.from(buf.map((b, i) => (i < n ? b ^ key[i % key.length] : b)))
const idpfKey = createHash('sha1').update(`urn:uuid:${UUID}`).digest()
const adobeKey = Buffer.from(UUID.replaceAll('-', ''), 'hex')

function writeFontsEpub(out) {
  const font = readFileSync(resolve(here, '../../../assets/fonts/SourceSans3-Regular.woff2'))
  epub(out, 'tsfonts.epub', {
    files: {
      'fonts/plain.woff2': font,
      'fonts/idpf.woff2': xor(font, idpfKey, 1040),
      'fonts/adobe.woff2': xor(font, adobeKey, 1024),
      'style.css': ['Plain', 'Idpf', 'Adobe'].map((f) => `@font-face { font-family: TS${f}; src: url(fonts/${f.toLowerCase()}.woff2) format("woff2") }`).join('\n')
        + '\n.plain { font-family: TSPlain, serif } .idpf { font-family: TSIdpf, serif } .adobe { font-family: TSAdobe, serif } .fallback { font-family: serif }',
      's1.xhtml': xhtml('<link rel="stylesheet" href="style.css"/>', ['plain', 'idpf', 'adobe', 'fallback']
        .map((c) => `<h2>${c}</h2><p class="${c}"><span id="${c}">${para}</span></p>`).join('')),
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
    // The retained EPUB's own directory: the dev route's page origin is file:// (ADR-029 Decision 4).
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
  return epub(out, 'tshostile.epub', {
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
 * `version` 8 is the header of one (nothing else of KF8 is written: the page refuses it on the header).
 * `boundary` adds an EXTH with record 121, the KF8 half of a MOBI/KF8 combo (here a record that is none).
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

/** tsformat.epub, tsformat.mobi, tsdrm.mobi (the same with the DRM flag), tsformat.fb2, tsformat.fbz, tsformat.cbz (2 pages). */
export function writeFormatFixtures(dir) {
  epub(resolve(dir, 'tsformat.epub'), 'TS EPUB', {
    files: { 's1.xhtml': xhtml('', `<h1>Chapter One</h1>${prose(30).map((p) => `<p>${p}</p>`).join('')}`) },
    manifest: '<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/>',
    spine: '<itemref idref="s1"/>',
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
  return ['tsformat.epub', 'tsformat.mobi', 'tsdrm.mobi', 'tsformat.fb2', 'tsformat.fbz', 'tsformat.cbz', 'tsupper.cbz', 'tsutf16.fb2', 'tskf8.mobi', 'tscombo.mobi']
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(fixtures, { recursive: true })
  writeFontsEpub(resolve(fixtures, 'tsfonts.epub'))
  writeHostileEpub(resolve(fixtures, 'tshostile.epub'), process.argv[2])
  const formats = writeFormatFixtures(fixtures)
  console.log(['tsfonts.epub', 'tshostile.epub', ...formats].map((f) => `fixtures/${f}`).join(', '))
}
