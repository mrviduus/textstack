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

import type { Chapter } from '@textstack/shared'

export interface CachedChapter {
  editionId: string
  chapterSlug: string
  chapterId: string | null
  html: string
  title: string
  wordCount: number | null
  prev: { chapterNumber: number; slug: string; title: string } | null
  next: { chapterNumber: number; slug: string; title: string } | null
  cachedAt: number
}

export interface CachedBookMeta {
  editionId: string
  slug: string
  title: string
  coverPath: string | null
  totalChapters: number
  cachedChapters: number
  cachedAt: number
}

export interface CachedChapterSummary {
  chapterSlug: string
  title: string
  cachedAt: number
}

export async function getCachedChapter(): Promise<CachedChapter | null> {
  return null
}

export async function refreshCachedChapter(_editionId: string, _chapter: Chapter): Promise<void> {
  // no-op
}

export async function cacheChapter(_editionId: string, _chapter: Chapter): Promise<void> {
  /* no-op on web */
}

export async function listCachedChapters(): Promise<CachedChapterSummary[]> {
  return []
}

export async function getCachedBookMeta(): Promise<CachedBookMeta | null> {
  return null
}

export async function setCachedBookMeta(_meta: CachedBookMeta): Promise<void> {
  /* no-op */
}

export async function updateCachedChapterCount(): Promise<void> {
  /* no-op */
}

export async function deleteCachedBook(): Promise<void> {
  /* no-op */
}

export async function getAllCachedBooks(): Promise<CachedBookMeta[]> {
  return []
}

export async function isBookFullyCached(): Promise<boolean> {
  return false
}

// ---- User-uploaded books ----
//
// Same no-op contract as above, mirroring the native module's surface so the
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

export async function getAllCachedUserBooks(): Promise<CachedUserBookMeta[]> {
  return []
}

export async function clearCachedUserBooks(): Promise<void> {
  /* no-op */
}

export async function isUserBookFullyCached(): Promise<boolean> {
  return false
}
