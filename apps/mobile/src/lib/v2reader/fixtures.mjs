// Crafted EPUBs for the gates no Project Gutenberg book covers (ADR-029 Decision 6). Generated, never
// committed (fixtures/ is gitignored); needs the `zip` CLI.
//   node fixtures.mjs [siblingDir]   → fixtures/tsfonts.epub, fixtures/tshostile.epub
// tsfonts: one font (Source Sans 3, OFL, from the app's assets) embedded three ways: plain, IDPF-obfuscated,
// Adobe-obfuscated. tshostile: one row of HOSTILE_VECTORS each, aimed at http://127.0.0.1:9876
// (sandbox.check.mjs serves and logs it; `adb reverse tcp:9876 tcp:9876` on Android) and at the files
// beside the retained EPUB (siblingDir, a file:// URL; default: the app's files on Android).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
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
  rmSync(out, { force: true })
  execFileSync('zip', ['-X0q', out, 'mimetype'], { cwd: dir })
  execFileSync('zip', ['-Xr9Dq', out, 'META-INF', 'OEBPS'], { cwd: dir })
  rmSync(dir, { recursive: true })
  return out
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
 * The hostile book, one row per vector (ADR-029 Decision 6): `[name, observe, { head?, body?, bodyAttrs?, files? }]`.
 * `observe` says how sandbox.check.mjs sees the vector get through, and the check refuses to start on a
 * kind or probe it does not implement:
 *   'mark'        a book script ran: it pushed `name` to `__pwned`
 *   'request'     a request reached EVIL/<name>…
 *   'probe:<id>'  a DOM probe in the check reads true (a sibling file loaded, <base> applied)
 *   'sandbox'     no CSP directive is observable here: foliate's iframe sandbox stops it first (README, Blind spots)
 * Elements with `data-ts-click="<name>"` are clicked by the check. `siblings` is the retained EPUB's directory.
 */
export const hostileVectors = (evil, siblings) => [
  // Book scripts. The section iframes allow scripts: the CSP's nonce is the only barrier.
  ['inline-script', 'mark', { head: `<script>${mark('inline-script')}</script>` }],
  ['script-src-in-zip', 'mark', { head: '<script src="evil.js"></script>', files: { 'evil.js': mark('script-src-in-zip') } }],
  ['body-onload', 'mark', { bodyAttrs: ` onload="${mark('body-onload')}"` }],
  ['img-onerror', 'mark', { body: `<img src="missing.png" onerror="${mark('img-onerror')}" alt=""/>` }],
  ['svg-inline-script', 'mark', { body: `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>${mark('svg-inline-script')}</script></svg>` }],
  // An SVG file with a script. As <img> it can never run script (decoration); as <object>/<embed> it is
  // stopped by object-src before the CSP's script-src would be asked.
  ['svg-file-script', 'mark', {
    body: '<img src="evil.svg" alt=""/><object data="evil.svg" type="image/svg+xml" width="10" height="10"></object><embed src="evil.svg" type="image/svg+xml" width="10" height="10"/>',
    files: { 'evil.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>${mark('svg-file-script')}</script></svg>` },
  }],
  ['srcdoc-script', 'mark', { body: `<iframe width="10" height="10" srcdoc="&lt;script&gt;${mark('srcdoc-script')}&lt;/script&gt;"></iframe>` }],
  // Also an escape if it reaches the host as openLink (#1066): the host hands that to the OS opener.
  ['javascript-url', 'mark', { body: `<p><a data-ts-click="javascript-url" href="javascript:${mark('javascript-url')}">javascript: link</a></p>` }],
  // The retained EPUB's own directory: on the dev route the page's origin is file:// (ADR-029 Decision 4).
  ['file-sibling-xhr', 'mark', { head: `<script>try{var x=new XMLHttpRequest();x.open('GET','${siblings}/secret.json',false);x.send();if(/ts-sibling-secret/.test(x.responseText)){${mark('file-sibling-xhr')}}}catch(e){}</script>` }],
  ['file-sibling-img', 'probe:file-sibling-img', { body: `<img id="file-sibling-img" src="${siblings}/secret.png" alt=""/>` }],
  ['file-sibling-css', 'probe:file-sibling-css', { head: `<link rel="stylesheet" href="${siblings}/secret.css"/>`, body: '<p id="file-sibling-css">styled by a sibling file?</p>' }],
  ['file-sibling-iframe', 'probe:file-frame', { body: `<iframe src="${siblings}/secret.json" width="10" height="10"></iframe>` }],
  // A relative URL under <base> would resolve to EVIL/base-href/…; the probe reads the base itself.
  ['base-href', 'probe:base-href', { head: `<base href="${evil}/base-href/"/>`, body: '<img src="base-href.png" alt=""/>' }],
  // Stripped by page.mjs before the section loads; Chromium's frame-src would also block the navigation.
  ['meta-refresh', 'request', { head: `<meta http-equiv="refresh" content="1;url=${evil}/meta-refresh"/>` }],
  ['link-stylesheet', 'request', { head: `<link rel="stylesheet" href="${evil}/link-stylesheet.css"/>` }],
  ['link-prefetch', 'request', { head: `<link rel="prefetch" href="${evil}/link-prefetch"/>` }],
  ['css-import', 'request', { head: `<style>@import url("${evil}/css-import.css");</style>` }],
  ['css-font', 'request', { head: `<style>@font-face { font-family: TsExt; src: url("${evil}/css-font.woff2") } h1 { font-family: TsExt }</style>` }],
  ['css-background', 'request', { head: `<style>h1 { background: url("${evil}/css-background.png") }</style>` }],
  ['img', 'request', { body: `<img src="${evil}/img.png" alt=""/>` }],
  ['img-srcset', 'request', { body: `<img srcset="${evil}/img-srcset.png 1x" alt=""/>` }],
  ['svg-image', 'request', { body: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="${evil}/svg-image.png" width="10" height="10"/></svg>` }],
  ['audio', 'request', { body: `<audio src="${evil}/audio.mp3" autoplay="autoplay"></audio>` }],
  ['video-poster', 'request', { body: `<video poster="${evil}/video-poster.png" width="10" height="10"></video>` }],
  ['iframe', 'request', { body: `<iframe src="${evil}/iframe" width="10" height="10"></iframe>` }],
  ['object', 'request', { body: `<object data="${evil}/object" width="10" height="10"></object>` }],
  ['embed', 'request', { body: `<embed src="${evil}/embed" width="10" height="10"/>` }],
  // The iframe sandbox has no allow-forms: with form-action removed it still cannot submit.
  ['form', 'sandbox', { body: `<form action="${evil}/form" method="get"><input name="q" value="x"/><button data-ts-click="form" type="submit">send</button></form>` }],
  // foliate hands an external link to the host (`openLink`); the page itself never navigates.
  ['link-tap', 'request', { body: `<p><a data-ts-click="link-tap" href="${evil}/link-tap">external link</a></p>` }],
]

export function writeHostileEpub(out, siblings = LOCAL) {
  const vectors = hostileVectors(EVIL, siblings)
  const part = (key) => vectors.map(([, , v]) => v[key] ?? '').filter(Boolean).join('\n')
  const files = Object.assign({}, ...vectors.map(([, , v]) => v.files))
  const items = Object.keys(files).map((f, i) => `<item id="r${i}" href="${f}" media-type="${f.endsWith('.js') ? 'application/javascript' : 'image/svg+xml'}"/>`).join('')
  return epub(out, 'tshostile.epub', {
    files: { ...files, 's1.xhtml': xhtml(part('head'), `<h1 id="ts-hostile">Hostile</h1><p>${para}</p>\n${part('body')}\n<p>${para}</p>`, part('bodyAttrs')) },
    manifest: `<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml" properties="scripted svg"/>${items}`,
    spine: '<itemref idref="s1"/>',
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(fixtures, { recursive: true })
  writeFontsEpub(resolve(fixtures, 'tsfonts.epub'))
  writeHostileEpub(resolve(fixtures, 'tshostile.epub'), process.argv[2])
  console.log('fixtures/tsfonts.epub, fixtures/tshostile.epub')
}
