// Crafted EPUBs for the gates no Project Gutenberg book covers (ADR-029 Decision 6). Generated, never
// committed (fixtures/ is gitignored); needs the `zip` CLI.
//   node fixtures.mjs   → fixtures/tsfonts.epub, fixtures/tshostile.epub
// tsfonts: one font (Source Sans 3, OFL, from the app's assets) embedded three ways: plain, IDPF-obfuscated,
// Adobe-obfuscated. tshostile: book scripts and external requests, all aimed at http://127.0.0.1:9876
// (the R3 hostile check serves and logs it; `adb reverse tcp:9876 tcp:9876` on Android), plus the app's
// own file:// files.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const EVIL = 'http://127.0.0.1:9876'
// The app's own private files: the dev route's page origin is file:// on Android (README.md).
const LOCAL = 'file:///data/user/0/app.textstack.mobile/files'
const UUID = '2c4a3b8e-5d1f-4e6a-9b7c-0123456789ab'

function epub(name, { files, manifest, spine, encryption }) {
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
  mkdirSync(resolve(here, 'fixtures'), { recursive: true })
  const out = resolve(here, 'fixtures', name)
  rmSync(out, { force: true })
  execFileSync('zip', ['-X0q', out, 'mimetype'], { cwd: dir })
  execFileSync('zip', ['-Xr9Dq', out, 'META-INF', 'OEBPS'], { cwd: dir })
  rmSync(dir, { recursive: true })
  return out
}

const xhtml = (head, body, attrs = '') => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>s</title>${head}</head><body${attrs}>${body}</body></html>`
const para = 'Sphinx of black quartz, judge my vow. The quick brown fox jumps over the lazy dog. '.repeat(3)

// OCF obfuscation: XOR the first 1040 (IDPF, key = SHA-1 of the identifier) or 1024 (Adobe, key = UUID bytes) bytes.
const xor = (buf, key, n) => Buffer.from(buf.map((b, i) => (i < n ? b ^ key[i % key.length] : b)))
const font = readFileSync(resolve(here, '../../../assets/fonts/SourceSans3-Regular.woff2'))
const idpfKey = createHash('sha1').update(`urn:uuid:${UUID}`).digest()
const adobeKey = Buffer.from(UUID.replaceAll('-', ''), 'hex')

epub('tsfonts.epub', {
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

// Every vector marks `top.__pwned` (a script ran) or hits EVIL/<vector> (a request left the book).
const mark = (v) => `(top.__pwned=top.__pwned||[]).push('${v}')`
epub('tshostile.epub', {
  files: {
    'evil.js': mark('script-src-in-zip'),
    'ext.css': '/* in-zip sheet */',
    's1.xhtml': xhtml(`<meta http-equiv="refresh" content="3;url=${EVIL}/meta-refresh"/>
<link rel="stylesheet" href="${EVIL}/link-stylesheet.css"/><link rel="prefetch" href="${EVIL}/link-prefetch"/>
<script>${mark('inline-script')}</script><script src="evil.js"></script>
<style>@import url("${EVIL}/css-import.css"); @font-face { font-family: Ext; src: url("${EVIL}/css-font.woff2") }
.bg { background: url("${EVIL}/css-background.png") } .ext { font-family: Ext } .loc { background: url("${LOCAL}/foliate-prototype-store.json") }</style>
<link rel="stylesheet" href="${LOCAL}/foliate-v2/library.json"/>`,
    `<h1>Hostile</h1><p class="bg ext">${para}</p>
<p><img src="missing.png" onerror="${mark('img-onerror')}" alt="x"/></p>
<p><img src="${EVIL}/img.png" alt="ext"/><img srcset="${EVIL}/img-srcset.png 1x" alt="ext2"/></p>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="${EVIL}/svg-image.png" width="10" height="10"/></svg>
<p><audio src="${EVIL}/audio.mp3" autoplay="autoplay"></audio><video poster="${EVIL}/video-poster.png" width="10" height="10"></video></p>
<iframe src="${EVIL}/iframe" width="10" height="10"></iframe><iframe src="${LOCAL}/" width="10" height="10"></iframe>
<p class="loc"><img src="${LOCAL}/foliate-prototype-store.json" alt="local"/></p><object data="${EVIL}/object" width="10" height="10"></object>
<form action="${EVIL}/form" method="get"><input name="q" value="x"/></form>
<p><a id="jsurl" href="javascript:${mark('javascript-url')}">javascript: link</a> · <a id="extlink" href="${EVIL}/link-tap">external link</a></p>
<p>${para}</p>`, ` onload="${mark('body-onload')}"`),
  },
  manifest: '<item id="s1" href="s1.xhtml" media-type="application/xhtml+xml" properties="scripted"/><item id="js" href="evil.js" media-type="application/javascript"/><item id="css" href="ext.css" media-type="text/css"/>',
  spine: '<itemref idref="s1"/>',
})
console.log('fixtures/tsfonts.epub, fixtures/tshostile.epub')
