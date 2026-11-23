/**
 * ADR-033 P3: a file's table of contents on the server (`book_files.toc`), as the reader page reads it from the file
 * (`described.toc`, packages/reader/src/chapters.mjs `tocEntries`). Sent at import (the upload pass) and, for a book
 * whose server copy has none, after an open. Platform-free.
 */
import * as syncApi from '../api/sync'
import { clip } from '../reader/textAnchor'

/** One entry, in reading order: `key` by chapters.mjs `chapterKey`, `fraction` where it starts (0–1). */
export interface FileTocEntry {
  key: string
  title: string
  depth: number
  fraction: number
}

/** The server's caps (`PUT …/toc`). */
export const MAX_TOC_BYTES = 256 * 1024
const MAX_KEY = 200
const MAX_TITLE = 500
const MAX_DEPTH = 6

/** UTF-8 length of a string well-formed JSON.stringify made (every surrogate paired). */
function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? 4 : c >= 0xdc00 && c < 0xe000 ? 0 : 3
  }
  return n
}

/**
 * What the server takes (never throws): well-formed entries only (a key of 1–200, a title trimmed and cut to 500, depth
 * a whole 0–6 (deeper is 6, anything else 0), fraction 0–1), each key once, within 256 KB as JSON: the deepest level is
 * dropped first, then the next; a list still over (5,000 top-level chapters) is cut at its end.
 */
export function tocForServer(entries: unknown, maxBytes = MAX_TOC_BYTES): FileTocEntry[] {
  if (!Array.isArray(entries)) return []
  const keys = new Set<string>()
  const out: FileTocEntry[] = []
  for (const e of entries as Partial<FileTocEntry>[]) {
    const { key, depth, fraction } = e ?? {}
    const title = typeof e?.title === 'string' ? clip(e.title.trim(), MAX_TITLE) : ''
    if (typeof key !== 'string' || !key || key.length > MAX_KEY || keys.has(key) || !title) continue
    if (typeof fraction !== 'number' || !(fraction >= 0 && fraction <= 1)) continue
    keys.add(key)
    out.push({ key, title, depth: Number.isInteger(depth) && depth! > 0 ? Math.min(depth!, MAX_DEPTH) : 0, fraction })
  }
  // `[` + entries joined by `,` + `]`.
  const sizes = out.map((e) => utf8Length(JSON.stringify(e)) + 1)
  const total = (keep: (e: FileTocEntry) => boolean) => out.reduce((n, e, i) => (keep(e) ? n + sizes[i] : n), 1)
  let depth = MAX_DEPTH
  while (depth > 0 && total((e) => e.depth <= depth) > maxBytes) depth--
  let size = 1
  return out.filter((e, i) => e.depth <= depth && (size += sizes[i]) <= maxBytes)
}

/**
 * After an open of a synced book (never in its way): a file the library says has no TOC on the server
 * (`BookFile.hasToc === false`) gets the page's `toc()`, once, and only a book with entries; anything else sends
 * nothing. Never throws (404, 409, 400, offline: nothing sent): true when a TOC was sent.
 */
export async function syncTocIfMissing(bookId: string, fileId: string, toc: () => Promise<unknown>, hasToc: boolean | undefined): Promise<boolean> {
  if (hasToc !== false) return false
  try {
    const entries = tocForServer(await toc())
    if (!entries.length) return false
    await syncApi.putFileToc(bookId, fileId, entries)
    return true
  } catch {
    return false
  }
}
