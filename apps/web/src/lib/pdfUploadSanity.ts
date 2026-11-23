// Client-side pre-upload sanity check for PDFs.
//
// Motivation (prod-confirmed): a user picked a PDF while the browser was still
// downloading it → a truncated file was uploaded, accepted, then failed to
// open with a scary "corrupted" error. We catch it BEFORE spending the
// upload. Mirrors the backend rule (which 400s the same case):
//   - `%PDF-` must appear within the first 1KB (header)
//   - BOTH `startxref` and `%%EOF` must appear within the last 64KB (trailer)
//
// The check is intentionally lenient: junk bytes may precede the header (some
// PDFs have a preamble) and the trailer is scanned as raw bytes (content may be
// binary — no utf-8 strict decode).

const HEADER_MARKER = bytesOf('%PDF-')
const STARTXREF_MARKER = bytesOf('startxref')
const EOF_MARKER = bytesOf('%%EOF')

/** How many bytes the caller should slice off the front / back. */
export const PDF_HEADER_BYTES = 1024
export const PDF_TAIL_BYTES = 65536

function bytesOf(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** True if `needle` occurs anywhere within `haystack` (raw byte search). */
function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true
  if (haystack.length < needle.length) return false
  const last = haystack.length - needle.length
  for (let i = 0; i <= last; i++) {
    let j = 0
    while (j < needle.length && haystack[i + j] === needle[j]) j++
    if (j === needle.length) return true
  }
  return false
}

/**
 * Structural sanity check for a PDF given its first ~1KB and last ~64KB.
 * `header` should be file.slice(0, 1024); `tail` should be file.slice(-65536).
 * Returns false for truncated / non-PDF files.
 */
export function looksLikeCompletePdf(header: Uint8Array, tail: Uint8Array): boolean {
  if (header.length === 0 || tail.length === 0) return false
  if (!includesBytes(header, HEADER_MARKER)) return false
  if (!includesBytes(tail, STARTXREF_MARKER)) return false
  if (!includesBytes(tail, EOF_MARKER)) return false
  return true
}

function isPdf(file: File): boolean {
  return /\.pdf$/i.test(file.name) || file.type === 'application/pdf'
}

/**
 * Reads the head + tail of a picked file and runs the sanity check. EPUB (and
 * anything not a PDF) skips the check and passes. On read failure we do NOT
 * block — the server-side 400 remains the backstop.
 */
export async function pdfFilePassesSanityCheck(file: File): Promise<boolean> {
  if (!isPdf(file)) return true
  try {
    const [headerBuf, tailBuf] = await Promise.all([
      file.slice(0, PDF_HEADER_BYTES).arrayBuffer(),
      file.slice(-PDF_TAIL_BYTES).arrayBuffer(),
    ])
    return looksLikeCompletePdf(new Uint8Array(headerBuf), new Uint8Array(tailBuf))
  } catch {
    // Couldn't read the file locally — don't block; let the server decide.
    return true
  }
}
