// V2 local library (pure; the host does the file I/O). One entry per imported file:
// { id, sha256, size, title, author, originalName, importedAt, openedAt }. `id` is the local book id;
// `sha256` is the file identity (the retained copy is books/<sha256>.epub, reader data is keyed by it).
export const LIBRARY_VERSION = 1

export function parseLibrary(json) {
  try {
    const l = JSON.parse(json)
    if (l?.v === LIBRARY_VERSION && Array.isArray(l.books)) return l
  } catch {}
  return null
}

export const emptyLibrary = () => ({ v: LIBRARY_VERSION, books: [] })

/**
 * The opened file into the library. Identical bytes (same SHA-256 + size) return the existing entry
 * untouched apart from `openedAt`: never a duplicate, never a reset.
 */
export function addOpened(lib, { sha256, size, title, author, originalName }, now = Date.now(), newId = randomId) {
  const existing = lib.books.find((b) => b.sha256 === sha256 && b.size === size)
  if (existing) return { lib: touch(lib, existing.id, now), entry: { ...existing, openedAt: now }, existing: true }
  const entry = {
    id: newId(), sha256, size,
    // A missing title falls back to the file name; a missing author stays empty.
    title: title?.trim() || originalName.replace(/\.epub$/i, ''), author: author?.trim() ?? '',
    originalName, importedAt: now, openedAt: now,
  }
  return { lib: { ...lib, books: [...lib.books, entry] }, entry, existing: false }
}

export const touch = (lib, id, now = Date.now()) => ({ ...lib, books: lib.books.map((b) => (b.id === id ? { ...b, openedAt: now } : b)) })

const randomId = () => `lb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
