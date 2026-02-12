#!/usr/bin/env node
/**
 * Generates a minimal EPUB with an inline image for E2E testing.
 * Output: test-book-images.epub in the same directory.
 */
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT = join(__dirname, 'test-book-images.epub')

// --- Minimal 10x10 red PNG (raw bytes) ---
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVQYV2P8z8Dwn4EIwDiqEF8oAQBf9AoL/k2CFAAAAABJRU5ErkJggg==',
  'base64'
)

// --- EPUB files ---
const MIMETYPE = 'application/epub+zip'

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

const CONTENT_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book With Images</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="uid">urn:uuid:e2e-test-images-001</dc:identifier>
    <dc:creator>E2E Test</dc:creator>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="img_test" href="images/test.png" media-type="image/png"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>`

const NAV_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Nav</title></head>
<body>
  <nav epub:type="toc">
    <ol><li><a href="chapter1.xhtml">Chapter with Image</a></li></ol>
  </nav>
</body>
</html>`

const CHAPTER1_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter with Image</title></head>
<body>
  <h1>Chapter with Image</h1>
  <p>This chapter contains an inline image for testing.</p>
  <img src="images/test.png" alt="Test red square" />
  <p>Text after the image to verify layout.</p>
</body>
</html>`

// --- ZIP builder (minimal, store-only for mimetype, deflate for rest) ---
// EPUB requires mimetype to be first entry, stored (no compression), no extra field

class ZipBuilder {
  constructor() {
    this.entries = []
    this.offset = 0
    this.buf = []
  }

  addStored(name, data) {
    const nameBytes = Buffer.from(name, 'utf-8')
    const dataBytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8')
    const crc = crc32(dataBytes)

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0)   // signature
    local.writeUInt16LE(20, 4)           // version needed
    local.writeUInt16LE(0, 6)            // flags
    local.writeUInt16LE(0, 8)            // compression: stored
    local.writeUInt16LE(0, 10)           // mod time
    local.writeUInt16LE(0, 12)           // mod date
    local.writeUInt32LE(crc, 14)         // crc32
    local.writeUInt32LE(dataBytes.length, 18) // compressed size
    local.writeUInt32LE(dataBytes.length, 22) // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26) // filename length
    local.writeUInt16LE(0, 28)           // extra field length
    nameBytes.copy(local, 30)

    const localOffset = this.offset
    this.buf.push(local, dataBytes)
    this.offset += local.length + dataBytes.length

    this.entries.push({ nameBytes, crc, compressedSize: dataBytes.length, uncompressedSize: dataBytes.length, localOffset, method: 0 })
  }

  finalize() {
    const cdStart = this.offset
    for (const e of this.entries) {
      const cd = Buffer.alloc(46 + e.nameBytes.length)
      cd.writeUInt32LE(0x02014b50, 0)    // signature
      cd.writeUInt16LE(20, 4)            // version made by
      cd.writeUInt16LE(20, 6)            // version needed
      cd.writeUInt16LE(0, 8)             // flags
      cd.writeUInt16LE(e.method, 10)     // compression
      cd.writeUInt16LE(0, 12)            // mod time
      cd.writeUInt16LE(0, 14)            // mod date
      cd.writeUInt32LE(e.crc, 16)
      cd.writeUInt32LE(e.compressedSize, 20)
      cd.writeUInt32LE(e.uncompressedSize, 24)
      cd.writeUInt16LE(e.nameBytes.length, 28)
      cd.writeUInt16LE(0, 30)            // extra field length
      cd.writeUInt16LE(0, 32)            // comment length
      cd.writeUInt16LE(0, 34)            // disk number
      cd.writeUInt16LE(0, 36)            // internal attrs
      cd.writeUInt32LE(0, 38)            // external attrs
      cd.writeUInt32LE(e.localOffset, 42)
      e.nameBytes.copy(cd, 46)
      this.buf.push(cd)
      this.offset += cd.length
    }

    const cdSize = this.offset - cdStart
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)    // signature
    eocd.writeUInt16LE(0, 4)             // disk number
    eocd.writeUInt16LE(0, 6)             // cd start disk
    eocd.writeUInt16LE(this.entries.length, 8)
    eocd.writeUInt16LE(this.entries.length, 10)
    eocd.writeUInt32LE(cdSize, 12)
    eocd.writeUInt32LE(cdStart, 16)
    eocd.writeUInt16LE(0, 20)            // comment length
    this.buf.push(eocd)

    return Buffer.concat(this.buf)
  }
}

// CRC32 implementation
function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

// --- Build EPUB ---
// EPUB spec: mimetype must be stored (no compression), first entry, no extra field
// All other files use stored too for simplicity (valid EPUB)

const zip = new ZipBuilder()
zip.addStored('mimetype', MIMETYPE)
zip.addStored('META-INF/container.xml', CONTAINER_XML)
zip.addStored('OEBPS/content.opf', CONTENT_OPF)
zip.addStored('OEBPS/nav.xhtml', NAV_XHTML)
zip.addStored('OEBPS/chapter1.xhtml', CHAPTER1_XHTML)
zip.addStored('OEBPS/images/test.png', PNG_BYTES)

const epub = zip.finalize()
writeFileSync(OUTPUT, epub)
console.log(`Created ${OUTPUT} (${epub.length} bytes)`)
