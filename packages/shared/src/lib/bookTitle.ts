/**
 * Book titles from file metadata or file names, cleaned of the junk real files carry.
 * Port of the former backend `BookTitleCleaner` plus file-name rules; the client is the
 * book's only parser (ADR-033), so this is where titles get cleaned.
 */

// Invisible "non-content" chars: whitespace and Unicode format chars (ZWSP, BOM, soft hyphen…).
const E = String.raw`[\s\p{Cf}]*`
const EMPTY_FOR_PARENS = new RegExp(String.raw`[\s\p{Cf}]*\(${E}for\b(?:${E}(?:\$\{[^}]*\}|\{\{[^}]*\}\}|\$[A-Za-z_][\w.]*|%\w+))?${E}\)${E}$`, 'iu')
const EMPTY_TAIL_PARENS = new RegExp(String.raw`${E}\(${E}\)${E}$`, 'u')
const TEMPLATE_PLACEHOLDER = /\$\{[^}]*\}|\{\{[^}]*\}\}|\$[A-Za-z_][\w.]*/g
const WORD_EXPORT_PREFIX = /^\s*microsoft\s+word\s*[-–—]\s*/i
const OFFICE_EXTENSION = /\.(docx?|pdf|rtf|pages|odt)\s*$/i
const COPY_SUFFIX = /\s+copy(\s+\d+(?:[.-]\d+)*)?\s*$/i
// "(z-library.sk, 1lib.sk, z-lib.sk)" / "[libgen.rs]": every item a lowercase domain. A code extension
// is not a TLD, so "(Node.js)", "(ASP.NET)", "(2nd Ed.)" survive.
const DOMAIN = String.raw`[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?!(?:js|ts|py|rb|cs|md)\b)[a-z]{2,}`
const DOMAIN_LIST_TAIL = new RegExp(String.raw`\s*[(\[]\s*${DOMAIN}(?:\s*,\s*${DOMAIN})*\s*[)\]]\s*$`)

/** A title with export prefixes, office extensions, "copy" markers, shadow-library tails and template junk removed. */
export function cleanBookTitle(title: string): string {
  let s = title
    .replace(WORD_EXPORT_PREFIX, '')
    .replace(OFFICE_EXTENSION, '')
    .replace(COPY_SUFFIX, '')
    .replace(OFFICE_EXTENSION, '') // "X.docx copy 5": the extension is only at the end once the marker is gone
    .replace(DOMAIN_LIST_TAIL, '')
    .replace(TEMPLATE_PLACEHOLDER, '')
  for (let i = 0; i < 3; i++) {
    const before = s
    s = s.replace(EMPTY_FOR_PARENS, '').replace(EMPTY_TAIL_PARENS, '')
    if (s === before) break
  }
  return s.trim()
}

/** A file name as a title: no extension, `_` as spaces, no "(1)" duplicate marker, then cleaned. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/_+/g, ' ').replace(/\s*\(\d+\)\s*$/, '')
  return cleanBookTitle(base).replace(/\s{2,}/g, ' ').trim() || name
}

/** The book's own title when it has a real one, else its file name's. */
export function bookTitle(metadataTitle: string | null | undefined, fileName: string): string {
  const meta = cleanBookTitle(metadataTitle ?? '')
  const base = fileName.replace(/\.[a-z0-9]+$/i, '')
  return meta && meta !== fileName && meta !== base ? meta : titleFromFileName(fileName)
}
