import { authFetch, API_BASE, ApiError } from './client'
import { trackBookUploaded } from '../lib/analytics'
import type { UserBookDetailResponse } from '@textstack/shared'

export interface UserBook {
  id: string
  title: string
  slug: string
  language: string
  author: string | null
  description: string | null
  coverPath: string | null
  genre: string | null
  status: 'Processing' | 'Ready' | 'Failed'
  errorMessage: string | null
  chapterCount: number
  totalWordCount: number | null
  createdAt: string
  completedAt: string | null
  progressPercent: number | null
  progressUpdatedAt: string | null
  progressChapterSlug: string | null
  tags?: string[]
  suggestedTags?: string[]
  // "Send to TextStack" web clips (Read later shelf). Present on every list row;
  // sourceUrl/readAt are null for non-clips and for unread clips respectively.
  sourceUrl?: string | null
  isClip?: boolean
  isRead?: boolean
  readAt?: string | null
  /** True when the original upload is a PDF → the card can open "Original layout"
   *  instantly. Absent on older payloads → false. */
  hasOriginalPdf?: boolean
}

export interface UserChapterSummary {
  id: string
  chapterNumber: number
  slug: string | null
  title: string
  wordCount: number | null
  /** 1-based PDF page where this chapter starts. Null for EPUBs / unknown. */
  sourceStartPage?: number | null
}

export interface TocEntry {
  title: string
  chapterNumber: number | null
  children: TocEntry[] | null
}

/** The shared wire type, with web's narrower status / chapter / TOC types. */
export interface UserBookDetail extends Omit<UserBookDetailResponse, 'status' | 'chapters' | 'toc'> {
  status: 'Processing' | 'Ready' | 'Failed'
  chapters: UserChapterSummary[]
  toc: TocEntry[] | null
}

export interface UserChapter {
  id: string
  chapterNumber: number
  slug: string | null
  title: string
  html: string
  wordCount: number | null
  previous: { chapterNumber: number; slug: string | null; title: string } | null
  next: { chapterNumber: number; slug: string | null; title: string } | null
}

export interface UploadResponse {
  userBookId: string
  jobId: string
  status: string
  /** True the instant a PDF lands (file stored at upload) → redirect can open
   *  "Original layout" before extraction finishes. Absent on older payloads → false. */
  hasOriginalPdf?: boolean
}

export interface StorageQuota {
  usedBytes: number
  limitBytes: number
  usedPercent: number
}

export async function uploadUserBook(
  file: File,
  title?: string,
  language?: string,
  onProgress?: (percent: number) => void
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const formData = new FormData()
    formData.append('file', file)
    if (title) formData.append('title', title)
    if (language) formData.append('language', language)

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress((e.loaded / e.total) * 100)
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // GA4: conversion signal — users who upload their own book are far
        // more valuable than passive catalog readers. Derive format from
        // extension since MIME for .epub is inconsistent across browsers.
        const ext = (file.name.split('.').pop() || '').toLowerCase()
        trackBookUploaded({ format: ext || 'unknown', sizeBytes: file.size })
        resolve(JSON.parse(xhr.responseText))
      } else {
        let error = `Upload failed: ${xhr.status}`
        try {
          const json = JSON.parse(xhr.responseText)
          if (json.error) error = json.error
        } catch {}
        reject(new Error(error))
      }
    })

    xhr.addEventListener('error', () => reject(new Error('Upload failed')))

    xhr.open('POST', `${API_BASE}/me/books/upload`)
    xhr.withCredentials = true
    xhr.send(formData)
  })
}

export interface GetUserBooksOptions {
  /** 'readlater' → only web clips (Read later shelf). Omit → Books tab (excludes clips). */
  shelf?: 'readlater'
  /** 'unread' → only unread books (applied within the chosen shelf). */
  status?: 'unread'
}

export async function getUserBooks(opts?: GetUserBooksOptions): Promise<UserBook[]> {
  const params = new URLSearchParams()
  if (opts?.shelf) params.set('shelf', opts.shelf)
  if (opts?.status) params.set('status', opts.status)
  const qs = params.toString()
  return authFetch<UserBook[]>(qs ? `/me/books?${qs}` : '/me/books')
}

/** Mark a clip read (isRead=true, readAt=now). Owner-scoped; 404 if not yours. */
export async function markUserBookRead(id: string): Promise<void> {
  await authFetch<void>(`/me/books/${id}/read`, { method: 'PUT' })
}

export async function getUserBook(id: string): Promise<UserBookDetail> {
  return authFetch<UserBookDetail>(`/me/books/${id}`)
}

export async function getUserBookChapter(bookId: string, slug: string): Promise<UserChapter> {
  return authFetch<UserChapter>(`/me/books/${bookId}/chapters/${slug}`)
}

export async function deleteUserBook(id: string): Promise<void> {
  await authFetch<void>(`/me/books/${id}`, { method: 'DELETE' })
}

export async function retryUserBook(id: string): Promise<void> {
  await authFetch<void>(`/me/books/${id}/retry`, { method: 'POST' })
}

// Re-fire LLM metadata enrichment (genre/year/description). Backend sets status
// to Pending and returns 202. Owner-scoped; 404 if not yours.
export async function enrichUserBook(id: string): Promise<void> {
  await authFetch<void>(`/me/books/${id}/enrich`, { method: 'POST' })
}

export async function cancelUserBook(id: string): Promise<void> {
  await authFetch<void>(`/me/books/${id}/cancel`, { method: 'POST' })
}

export async function markUserBookComplete(id: string): Promise<void> {
  await authFetch<void>(`/me/books/${id}/complete`, { method: 'POST' })
}

export async function unmarkUserBookComplete(id: string): Promise<void> {
  await authFetch<void>(`/me/books/${id}/complete`, { method: 'DELETE' })
}

export async function getStorageQuota(): Promise<StorageQuota> {
  return authFetch<StorageQuota>('/me/books/quota')
}

export interface UpdateUserBookMetadataRequest {
  title: string
  author?: string | null
  language: string
  genre?: string | null
  description?: string | null
  publishedYear?: number | null
}

export async function updateUserBookMetadata(
  id: string,
  data: UpdateUserBookMetadataRequest,
): Promise<UserBookDetail> {
  return authFetch<UserBookDetail>(`/me/books/${id}/metadata`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export function getUserBookCoverUrl(coverPath: string | null | undefined): string | undefined {
  if (!coverPath) return undefined
  return `${API_BASE}/storage/${coverPath}`
}

/**
 * URL of the original uploaded PDF (Range-enabled) for the Original-layout view.
 * Cookie-authed same-origin; pass to pdf.js via `getDocument({ url, withCredentials: true })`.
 */
export function getUserBookFileUrl(id: string): string {
  return `${API_BASE}/me/books/${id}/file`
}

// Tags API
export interface TagCount {
  tag: string
  count: number
}

export async function setUserBookTags(bookId: string, tags: string[]): Promise<string[]> {
  return authFetch<string[]>(`/me/books/${bookId}/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  })
}

export async function getUserTags(): Promise<TagCount[]> {
  return authFetch<TagCount[]>('/me/library/tags')
}

export async function acceptSuggestedTags(bookId: string, accepted: string[]): Promise<string[]> {
  return authFetch<string[]>(`/me/books/${bookId}/suggested-tags/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accepted }),
  })
}

export async function dismissSuggestedTags(bookId: string): Promise<void> {
  await authFetch<void>(`/me/books/${bookId}/suggested-tags/dismiss`, { method: 'POST' })
}

// Bulk actions
export interface BulkResult {
  succeeded: string[]
  failed: { id: string; reason: string }[]
}

export async function bulkFinishUserBooks(ids: string[], isFinished: boolean): Promise<BulkResult> {
  return authFetch<BulkResult>('/me/books/bulk/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, isFinished }),
  })
}

export async function bulkDeleteUserBooks(ids: string[]): Promise<BulkResult> {
  return authFetch<BulkResult>('/me/books/bulk/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
}

export async function bulkTagUserBooks(ids: string[], addTags: string[], removeTags: string[]): Promise<BulkResult> {
  return authFetch<BulkResult>('/me/books/bulk/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, addTags, removeTags }),
  })
}

export async function bulkAddToCollection(collectionId: string, ids: string[], bookType: 'userbook' | 'savedbook'): Promise<BulkResult> {
  return authFetch<BulkResult>(`/me/books/bulk/collection/${collectionId}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, bookType }),
  })
}

export interface UserBookSearchHit {
  id: string
  title: string
  author: string | null
  coverPath: string | null
  language: string
  rank: number
  excerpt: string | null
  chapterSlug: string | null
}

export async function searchUserLibrary(
  query: string,
  tags: string[],
  signal?: AbortSignal,
): Promise<UserBookSearchHit[]> {
  const params = new URLSearchParams({ q: query })
  if (tags.length > 0) params.set('tags', tags.join(','))
  return authFetch<UserBookSearchHit[]>(`/me/library/search?${params}`, { signal })
}

export interface UserBookStats {
  bookId: string
  sessionsCount: number
  totalReadMinutes: number
  wordsRead: number
  vocabSavedCount: number
  highlightsCount: number
  averageWordsPerMinute: number
  estimatedMinutesRemaining: number | null
}

export async function getUserBookStats(bookId: string): Promise<UserBookStats> {
  return authFetch<UserBookStats>(`/me/books/${bookId}/stats`)
}

export async function bulkRemoveFromCollection(collectionId: string, ids: string[], bookType: 'userbook' | 'savedbook'): Promise<BulkResult> {
  return authFetch<BulkResult>(`/me/books/bulk/collection/${collectionId}/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, bookType }),
  })
}

// Progress API
export interface UserBookProgress {
  chapterSlug: string | null
  locator: string | null
  percent: number | null
  updatedAt: string | null
  /** Where the reader is IN THE TEXT, serialised (ADR-015). Prefer it over
   *  `locator`: a pixel offset stops being true the moment the text reflows. */
  positionJson?: string | null
  /** Client clock of the kept write — compare local stamps with this, never `updatedAt`. */
  clientUpdatedAt?: string | null
}

export async function getUserBookProgress(bookId: string): Promise<UserBookProgress | null> {
  return (await readUserBookProgress(bookId)) ?? null
}

/** The reader's read: `null` answered with nothing, `undefined` no answer — see `readProgress`
 *  in api/auth.ts. */
export async function readUserBookProgress(bookId: string, signal?: AbortSignal): Promise<UserBookProgress | null | undefined> {
  try {
    return await authFetch<UserBookProgress>(`/me/books/${bookId}/progress`, { signal })
  } catch (e) {
    return e instanceof ApiError && e.status === 404 ? null : undefined
  }
}

export async function saveUserBookProgress(
  bookId: string,
  // chapterSlug is nullable — a chapterless PDF read in Original layout sends
  // null with a "page:<N>" locator (ADR-012 S2).
  // The type had stopped describing the request: it named neither percentUnit
  // nor locatorKind, so a caller could omit one and the compiler said nothing.
  // That is exactly how this client shipped without percentUnit and quietly
  // stored no percentage at all.
  data: {
    chapterSlug: string | null
    locator?: string
    percent?: number
    percentUnit?: string
    locatorKind?: string
    updatedAt?: string
    /** Serialised TextPosition (ADR-015). Beside the locator, never instead. */
    positionJson?: string
  }
): Promise<void> {
  await authFetch<void>(`/me/books/${bookId}/progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

// Bookmark API
export interface UserBookBookmark {
  id: string
  // Nullable: a chapterless PDF read in Original layout stores a page bookmark
  // (`chapterId: null`, `locator: "page:<N>"`).
  chapterId: string | null
  chapterSlug: string | null
  locator: string
  title: string | null
  createdAt: string
}

export async function getUserBookBookmarks(bookId: string): Promise<UserBookBookmark[]> {
  return authFetch<UserBookBookmark[]>(`/me/books/${bookId}/bookmarks`)
}

export async function createUserBookBookmark(
  bookId: string,
  // chapterId is nullable — Original-layout page bookmarks send null + "page:<N>".
  data: { chapterId: string | null; locator: string; title?: string }
): Promise<UserBookBookmark> {
  return authFetch<UserBookBookmark>(`/me/books/${bookId}/bookmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

export async function deleteUserBookBookmark(bookId: string, bookmarkId: string): Promise<void> {
  await authFetch<void>(`/me/books/${bookId}/bookmarks/${bookmarkId}`, {
    method: 'DELETE',
  })
}
