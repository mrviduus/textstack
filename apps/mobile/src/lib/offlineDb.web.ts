// Web stub for offlineDb. The native implementation pulls in expo-sqlite,
// which transitively imports `.wasm` via its web shim — Metro's web bundler
// can't resolve that, breaking `eas update --platform=all`.
//
// We don't ship offline reading on web (DownloadContext also no-ops for web),
// so every export here is a safe no-op that satisfies the same surface the
// native module exposes.
//
// If a web feature ever needs offline persistence, replace these stubs with
// IndexedDB-backed implementations rather than re-introducing expo-sqlite on
// web.

// ---- User-uploaded books ----
//
// A no-op contract, mirroring the native module's surface so the
// web bundle resolves every import. Offline reading of uploads is a native
// feature: the cache is SQLite, and web has no equivalent here yet.

export interface CachedUserChapter {
  bookId: string
  chapterSlug: string
  chapterId: string
  html: string
  title: string
  wordCount: number | null
  chapterNumber: number | null
  sourceStartPage: number | null
  prev: { chapterNumber: number; slug: string; title: string } | null
  next: { chapterNumber: number; slug: string; title: string } | null
  cachedAt: number
}

export interface CachedUserBookMeta {
  bookId: string
  title: string
  author: string | null
  coverPath: string | null
  language: string | null
  totalChapters: number
  cachedChapters: number
  totalWordCount: number | null
  isPdf: boolean
  cachedAt: number
  fileId?: string | null
}

export async function getCachedUserChapter(): Promise<CachedUserChapter | null> {
  return null
}

export async function refreshCachedUserChapter(): Promise<void> {
  // no-op
}

export async function cacheUserChapter(): Promise<void> {
  /* no-op on web */
}

export async function storeCachedUserChapterStartPages(): Promise<void> {
  // no-op
}

export async function listCachedUserChapterPages(): Promise<{ slug: string; sourceStartPage: number | null }[]> {
  return []
}

export async function listCachedUserChapters(): Promise<CachedUserChapter[]> {
  return []
}

export async function getCachedUserBookMeta(): Promise<CachedUserBookMeta | null> {
  return null
}

export async function setCachedUserBookMeta(_meta: CachedUserBookMeta): Promise<void> {
  /* no-op */
}

export async function updateCachedUserChapterCount(): Promise<void> {
  /* no-op */
}

export async function deleteCachedUserBook(): Promise<void> {
  /* no-op */
}

export async function dropReplacedUserBookFiles(): Promise<string[]> {
  return []
}

export async function getAllCachedUserBooks(): Promise<CachedUserBookMeta[]> {
  return []
}

export async function rekeyCachedUserBooks(): Promise<void> {}

export function onCachedUserBooksChanged(_listener: (bookIds: string[]) => void): () => void {
  return () => {}
}

export async function clearCachedUserBooks(): Promise<void> {
  /* no-op */
}

export async function hasAnyUserBookCache(): Promise<boolean> {
  return false
}

export async function listUserBookCaches(): Promise<Map<string, boolean>> {
  return new Map()
}

export async function userBookRowBytes(): Promise<number> {
  return 0
}

export async function isUserBookFullyCached(): Promise<boolean> {
  return false
}
