// Which reader a file goes to (#1128), from its bytes only: the hosts' file names say `.epub` for every
// format (the Android host stages and retains as `*.epub`, the web host opens a blob: URL). Pure:
// page.mjs and the tests import it.

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to))
const u32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u16 = (b, at) => (b[at] << 8) | b[at + 1]

/** A refusal the host shows as is (`open-failed`'s `error`). */
export class UnsupportedBook extends Error {}

/**
 * The container: `zip` (EPUB, CBZ, FBZ — told apart by `zipFormat`), `mobi` (MOBI and KF8/AZW3, one
 * PDB container), `fb2`; throws UnsupportedBook for what this page does not read or refuses.
 */
export function sniffFormat(bytes) {
  if (bytes.length >= 4 && u32(bytes, 0) === 0x504b0304) return 'zip'
  if (ascii(bytes, 0, 5) === '%PDF-') throw new UnsupportedBook('PDF is not supported yet')
  // KFX: Amazon's newer format, DRM-wrapped as a rule ("\xeaDRMION\xee"); foliate has no reader for it.
  if (ascii(bytes, 0, 8) === '\xeaDRMION\xee') throw new UnsupportedBook('this Kindle book is DRM-protected (KFX) and cannot be opened')
  if (bytes.length >= 78 && ascii(bytes, 60, 68) === 'BOOKMOBI') {
    if (mobiEncryption(bytes)) throw new UnsupportedBook('this Kindle book is DRM-protected and cannot be opened')
    return 'mobi'
  }
  // FB2 is XML: its root element within the first KiB (after a BOM, a declaration, comments).
  if (/<FictionBook[\s>]/.test(ascii(bytes, 0, Math.min(bytes.length, 1024)))) return 'fb2'
  throw new UnsupportedBook('not a book this reader opens (EPUB, MOBI, AZW3, FB2, CBZ)')
}

/**
 * The PalmDOC header's `encryption` (0 none, 1 old Mobipocket, 2 Mobipocket DRM): record 0 starts at the
 * offset in the first record-list entry (byte 78). A record 0 past the end reads as unencrypted and is
 * left to foliate's parser to reject.
 */
export function mobiEncryption(bytes) {
  const record0 = u32(bytes, 78)
  return record0 + 14 <= bytes.length ? u16(bytes, record0 + 12) : 0
}

const IMAGE = /\.(jpe?g|png|gif|bmp|webp|svg|jxl|avif)$/i

/** A zip's format by its entry names: OCF container → EPUB; an .fb2 inside → FBZ; images → CBZ (foliate's rules, by content). */
export function zipFormat(names) {
  if (names.includes('META-INF/container.xml')) return 'epub'
  if (names.some((n) => n.toLowerCase().endsWith('.fb2'))) return 'fbz'
  if (names.some((n) => IMAGE.test(n))) return 'cbz'
  throw new UnsupportedBook('a zip with no book in it (no EPUB container, FB2 or images)')
}

/** Formats with text: word tap, selection, highlights and translation. A comic book is images only. */
export const isTextual = (format) => format !== 'cbz'
