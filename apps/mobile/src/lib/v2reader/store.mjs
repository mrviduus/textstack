// V2 reader data (ADR-029): one entry per book FILE (its SHA-256 + size). The page owns the shape; the
// host only keeps the JSON it is sent. An entry for other bytes, or a shape this code does not know, is
// not applied. Pure: page.mjs and the tests import it.
export const STORE_VERSION = 1

/** { v, book: { sha256, size, name }, position: null | { cfi, quote, index, fraction, at }, highlights: [] } */
export function emptyEntry(book) {
  return { v: STORE_VERSION, book, position: null, highlights: [] }
}

/** A position or highlight this code can act on: a CFI and the text that was there. */
const isQuoted = (x) => typeof x?.cfi === 'string' && x.cfi.startsWith('epubcfi(') && typeof x.quote === 'string' && x.quote.length > 0

/** The stored entry for this file, or null (missing, corrupt, another version, other bytes). */
export function entryFor(json, book) {
  let e
  try { e = JSON.parse(json) } catch { return null }
  if (e?.v !== STORE_VERSION || e.book?.sha256 !== book.sha256 || e.book?.size !== book.size) return null
  if (!Array.isArray(e.highlights)) return null
  // Only items this code can use. A stored highlight or position without its quote would throw on
  // restore, and a page that throws there never finishes restoring and never saves again.
  return { ...e, position: isQuoted(e.position) ? e.position : null, highlights: e.highlights.filter(isQuoted) }
}

export const withPosition = (e, p) => (isQuoted(p) ? { ...e, position: p } : e)
/** Same id replaces (a re-anchored highlight), otherwise appends. */
export const withHighlight = (e, h) => (isQuoted(h) && h.id ? { ...e, highlights: [...e.highlights.filter((x) => x.id !== h.id), h] } : e)

/**
 * Text without whitespace (NBSP and block breaks included) or soft hyphens, with curly quotes, primes,
 * dashes and the ellipsis folded to ASCII: a CFI is trusted only while the text there still reads as
 * its saved quote, and layout or typography alone must not break that.
 */
export const foldText = (text) => text
  .replace(/[\s\u00AD]/g, '')
  .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
  .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
  .replace(/[\u2010-\u2015]/g, '-')
  .replace(/\u2026/g, '...')

// SHA-256 (FIPS 180-4), in plain JS: crypto.subtle exists only in a secure context, and whether the
// page keeps its file:// origin is open until the R4 security review (ADR-029 Decision 4). At origin
// "null" (the production reader's) there is none.
const K = Uint32Array.from('428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2'.split(' '), (h) => parseInt(h, 16))
export function sha256(bytes) {
  const n = bytes.length
  const padded = new Uint8Array(((n + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[n] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, Math.floor(n / 0x20000000))
  dv.setUint32(padded.length - 4, n << 3)
  const H = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19)
  const W = new Uint32Array(64)
  const rotr = (x, r) => (x >>> r) | (x << (32 - r))
  for (let o = 0; o < padded.length; o += 64) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(o + t * 4)
    for (let t = 16; t < 64; t++) {
      const a = W[t - 15], b = W[t - 2]
      W[t] = W[t - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[t - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h
  }
  return [...H].map((x) => x.toString(16).padStart(8, '0')).join('')
}

// SHA-1 (FIPS 180-4), for the IDPF font-obfuscation key only (EPUB OCF): foliate's default is
// crypto.subtle, missing at origin "null" (see sha256). Input: the package's unique identifier.
export function sha1(str) {
  const bytes = new TextEncoder().encode(str)
  const n = bytes.length
  const padded = new Uint8Array(((n + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[n] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 4, n << 3)
  const H = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0)
  const W = new Uint32Array(80)
  const rotl = (x, r) => (x << r) | (x >>> (32 - r))
  for (let o = 0; o < padded.length; o += 64) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(o + t * 4)
    for (let t = 16; t < 80; t++) W[t] = rotl(W[t - 3] ^ W[t - 8] ^ W[t - 14] ^ W[t - 16], 1)
    let [a, b, c, d, e] = H
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 || t >= 60 ? b ^ c ^ d : (b & c) | (b & d) | (c & d)
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const tmp = (rotl(a, 5) + f + e + k + W[t]) >>> 0
      e = d; d = c; c = rotl(b, 30) >>> 0; b = a; a = tmp
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e
  }
  const out = new Uint8Array(20)
  H.forEach((h, i) => new DataView(out.buffer).setUint32(i * 4, h))
  return out
}
