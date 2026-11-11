// Which reader a file goes to (#1128), from its bytes only: the hosts' file names say `.epub` for every
// format (the Android host stages and retains as `*.epub`, the web host opens a blob: URL). Pure:
// page.mjs and the tests import it.

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, Math.min(to, bytes.length)))
const u32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u16 = (b, at) => (b[at] << 8) | b[at + 1]

/** Bytes searched for the FB2 root: room for a declaration, a long comment or a doctype before it. */
const FB2_WINDOW = 4096

/**
 * The container: `zip` (EPUB, CBZ, FBZ — told apart by `zipFormat`), `mobi` (MOBI6, KF8/AZW3, or the KF8
 * half of a MOBI/KF8 combo), `pdf`, `fb2`; throws, with the message the host shows (`open-failed`), for what this page does not read or refuses. Cheap and
 * pure: the page calls it before it touches the open book, so a refusal leaves that book as it was.
 */
export function sniffFormat(bytes) {
  if (bytes.length >= 4 && u32(bytes, 0) === 0x504b0304) return 'zip'
  // KFX: Amazon's newer format, DRM-wrapped as a rule ("\xeaDRMION\xee"); foliate has no reader for it.
  if (ascii(bytes, 0, 8) === '\xeaDRMION\xee') throw new Error('this Kindle book is DRM-protected (KFX) and cannot be opened')
  if (ascii(bytes, 60, 68) === 'BOOKMOBI') {
    const h = mobiHeader(bytes)
    // The header foliate reads the book by: KF8's own, or a combo's KF8 half, which foliate prefers to its
    // MOBI6 half. Both are checked here, before the open book is touched.
    const kf8 = h.version >= 8 ? h : h.boundary === undefined ? null : kf8Half(bytes, h.boundary)
    if (h.encryption || kf8?.encryption) throw new Error('this Kindle book is DRM-protected and cannot be opened')
    // foliate fails on a missing SKEL/FRAG index only inside the open, after teardown.
    // ponytail: the INDX magic only; a damaged index body still fails there (an open-failed, the old book gone).
    if (kf8 && !(isIndx(bytes, kf8.base + kf8.skel) && isIndx(bytes, kf8.base + kf8.frag))) throw new Error('this Kindle file is truncated or damaged')
    return 'mobi'
  }
  // pdf.js, like other PDF readers, takes the header anywhere in the first KiB (junk before it is common).
  // A substring search, so it runs after every format told by its own magic (zip, KFX, a PDB whose name may
  // say anything) and never on a book or page of markup: an FB2 root in the FB2 window, or an HTML root in
  // the first KiB, is that, whatever it quotes. Other junk before the header (a server's HTML warning
  // `<br />…`) is still a PDF's.
  const head = ascii(bytes, 0, 1024)
  const markup = /<FictionBook[\s>]/.test(ascii(bytes, 0, FB2_WINDOW).replace(/\0/g, '')) || /<html[\s>]|<!doctype html/i.test(head)
  if (!markup && head.includes('%PDF-')) return 'pdf'
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
  if (root < 0) throw new Error('not a book this reader opens (EPUB, MOBI, FB2, CBZ, PDF)')
  if (/<!ENTITY/i.test(head.slice(0, root))) throw new Error('unsupported FB2: custom entities')
}

/** Where record `i` of a PDB starts (undefined past its record list). */
const recordAt = (bytes, i) => (i < u16(bytes, 76) && 78 + i * 8 + 4 <= bytes.length ? u32(bytes, 78 + i * 8) : undefined)
const isIndx = (bytes, i) => { const at = recordAt(bytes, i); return at !== undefined && ascii(bytes, at, at + 4) === 'INDX' }

/**
 * A MOBI header record of a PDB `BOOKMOBI` (record 0 by default): its PalmDOC `encryption` (0 none, 1 old
 * Mobipocket, 2 Mobipocket DRM), the MOBI header `version` (8 = KF8), the last EXTH 121 `boundary` (a MOBI/KF8
 * combo's KF8 header record; foliate keeps the last), and a KF8 header's SKEL and FRAG index records,
 * relative to `base` (the header's own record). Throws for a file too short to hold what is read: truncated, not DRM.
 */
export function mobiHeader(bytes, base = 0) {
  const damaged = () => new Error('this Kindle file is truncated or damaged')
  if (bytes.length < 86) throw damaged()
  const r0 = recordAt(bytes, base) ?? bytes.length
  if (r0 + 248 > bytes.length || ascii(bytes, r0 + 16, r0 + 20) !== 'MOBI') throw damaged()
  let boundary
  if (u32(bytes, r0 + 128) & 0x40) {
    const exth = r0 + 16 + u32(bytes, r0 + 20)
    if (exth + 12 > bytes.length || ascii(bytes, exth, exth + 4) !== 'EXTH') throw damaged()
    for (let i = 0, at = exth + 12, n = u32(bytes, exth + 8); i < n && at + 8 <= bytes.length; i++) {
      const [type, len] = [u32(bytes, at), u32(bytes, at + 4)]
      if (len < 8) break
      if (type === 121 && at + 12 <= bytes.length) boundary = u32(bytes, at + 8)
      at += len
    }
  }
  const version = u32(bytes, r0 + 36)
  if (version >= 8 && r0 + 256 > bytes.length) throw damaged()
  return { encryption: u16(bytes, r0 + 12), version, boundary, base, ...(version >= 8 && { frag: u32(bytes, r0 + 248), skel: u32(bytes, r0 + 252) }) }
}

/**
 * A combo's KF8 header (record `boundary`), as foliate takes it: none where there is no MOBI header there
 * (foliate then falls back to the MOBI6 half). Any MOBI header there is read as KF8, so one below version 8
 * has no indexes and is refused as damaged.
 */
function kf8Half(bytes, boundary) {
  const at = recordAt(bytes, boundary)
  return at === undefined || ascii(bytes, at + 16, at + 20) !== 'MOBI' ? null : mobiHeader(bytes, boundary)
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
