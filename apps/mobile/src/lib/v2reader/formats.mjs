// Which reader a file goes to (#1128), from its bytes only: the hosts' file names say `.epub` for every
// format (the Android host stages and retains as `*.epub`, the web host opens a blob: URL). Pure:
// page.mjs and the tests import it.

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)))
const u32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u16 = (b, at) => (b[at] << 8) | b[at + 1]

/** Bytes searched for the FB2 root: room for a declaration, a long comment or a doctype before it. */
const FB2_WINDOW = 4096

/**
 * The container: `zip` (EPUB, CBZ, FBZ — told apart by `zipFormat`), `mobi` (MOBI6, or the MOBI6 half of a
 * MOBI/KF8 combo), `fb2`; throws, with the message the host shows (`open-failed`), for what this page does not read or refuses. Cheap and
 * pure: the page calls it before it touches the open book, so a refusal leaves that book as it was.
 */
export function sniffFormat(bytes) {
  if (bytes.length >= 4 && u32(bytes, 0) === 0x504b0304) return 'zip'
  if (ascii(bytes, 0, 5) === '%PDF-') throw new Error('PDF is not supported yet')
  // KFX: Amazon's newer format, DRM-wrapped as a rule ("\xeaDRMION\xee"); foliate has no reader for it.
  if (ascii(bytes, 0, 8) === '\xeaDRMION\xee') throw new Error('this Kindle book is DRM-protected (KFX) and cannot be opened')
  if (ascii(bytes, 60, 68) === 'BOOKMOBI') {
    const h = mobiHeader(bytes)
    if (h.encryption) throw new Error('this Kindle book is DRM-protected and cannot be opened')
    // The fork's KF8 reader (pin d73682a) is unverified and makes its resource blobs without a type
    // (mobi.js loadResourceBlob: `{ newType }` for `{ type: newType }`); its sections also bypass the
    // transformTarget the page strips refresh metas through. Refused until the fork is fixed.
    if (h.version >= 8) throw new Error('AZW3 (KF8) is not supported yet')
    return 'mobi'
  }
  // The last candidate: anything that is not an FB2 is refused there as "not a book".
  checkFb2(bytes)
  return 'fb2'
}

/**
 * An FB2 the XML parser may be handed: its root near the start and no entity declared before it. A flat
 * entity referenced tens of thousands of times hangs or kills the renderer (Blink stops only nested
 * expansion); real FB2 files declare none. Also called for the FB2 inside an FBZ.
 */
export function checkFb2(bytes) {
  // The first FB2_WINDOW bytes as text, NULs dropped so UTF-16 (either order) reads like ASCII.
  const head = ascii(bytes, 0, FB2_WINDOW).replace(/\0/g, '')
  const root = head.search(/<FictionBook[\s>]/)
  if (root < 0) throw new Error('not a book this reader opens (EPUB, MOBI, FB2, CBZ)')
  if (/<!ENTITY/i.test(head.slice(0, root))) throw new Error('unsupported FB2: custom entities')
}

/**
 * Record 0 of a PDB `BOOKMOBI`: its PalmDOC `encryption` (0 none, 1 old Mobipocket, 2 Mobipocket DRM), the
 * MOBI header `version` (8 = KF8), and where each EXTH 121 (the KF8 boundary of a MOBI/KF8 combo) keeps
 * its value. Throws for a file too short to hold what is read: truncated, not DRM.
 */
export function mobiHeader(bytes) {
  const damaged = () => new Error('this Kindle file is truncated or damaged')
  if (bytes.length < 86) throw damaged()
  const r0 = u32(bytes, 78)
  if (r0 + 248 > bytes.length || ascii(bytes, r0 + 16, r0 + 20) !== 'MOBI') throw damaged()
  const boundaries = []
  if (u32(bytes, r0 + 128) & 0x40) {
    const exth = r0 + 16 + u32(bytes, r0 + 20)
    if (exth + 12 > bytes.length || ascii(bytes, exth, exth + 4) !== 'EXTH') throw damaged()
    for (let i = 0, at = exth + 12, n = u32(bytes, exth + 8); i < n && at + 8 <= bytes.length; i++) {
      const [type, len] = [u32(bytes, at), u32(bytes, at + 4)]
      if (len < 8) break
      if (type === 121 && at + 12 <= bytes.length) boundaries.push(at + 8)
      at += len
    }
  }
  return { encryption: u16(bytes, r0 + 12), version: u32(bytes, r0 + 36), boundaries }
}

/**
 * A combo file read as its MOBI6 half: every KF8 boundary set to "none" (0xffffffff), the value
 * foliate's MOBI reader takes for a plain MOBI6. In place; the page hashed the bytes before.
 */
export function withoutKf8(bytes) {
  for (const at of mobiHeader(bytes).boundaries) bytes.fill(0xff, at, at + 4)
  return bytes
}

/**
 * An FB2 as UTF-8: foliate decodes FB2 as UTF-8 first and trusts the declaration only after, so a UTF-16
 * file never parses. Re-encoded, with its declaration saying utf-8. Anything else is returned as is.
 */
export function fb2AsUtf8(bytes) {
  const [a, b] = bytes
  const enc = a === 0xff && b === 0xfe ? 'utf-16le' : a === 0xfe && b === 0xff ? 'utf-16be'
    : a === 0x3c && b === 0 ? 'utf-16le' : a === 0 && b === 0x3c ? 'utf-16be' : null
  if (!enc) return bytes
  const text = new TextDecoder(enc).decode(bytes).replace(/^(<\?xml[^>]*?encoding\s*=\s*)["'][^"']*["']/, '$1"utf-8"')
  return new TextEncoder().encode(text)
}

/** A zip's format by its entry names: OCF container → EPUB; an .fb2 inside → FBZ; images → CBZ (foliate's rules, by content). */
export function zipFormat(names) {
  if (names.includes('META-INF/container.xml')) return 'epub'
  if (names.some((n) => n.toLowerCase().endsWith('.fb2'))) return 'fbz'
  if (names.some(imageType)) return 'cbz'
  throw new Error('a zip with no book in it (no EPUB container, FB2 or images)')
}

/**
 * A CBZ entry's name with its extension in lower case: foliate's comic reader keeps `.jpg`, never `.JPG`.
 * The page's loader answers both spellings.
 */
export const comicName = (n) => n.replace(/\.[^./]+$/, (ext) => ext.toLowerCase())

const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', jxl: 'image/jxl', avif: 'image/avif' }
/** A comic page's MIME type by its extension ('' if unknown): an SVG blob without one is no image. */
export const imageType = (n) => IMAGE_TYPES[/\.(\w+)$/.exec(n)?.[1].toLowerCase()] ?? ''

/** Formats with text: word tap, selection, highlights and translation. A comic book is images only. */
export const isTextual = (format) => format !== 'cbz'
