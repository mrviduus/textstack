import type { UserBookProgressDto } from '@textstack/shared'
import { authFetch, API_BASE, ApiError } from './client'
import { trackBookUploaded } from '../lib/analytics'
import { refreshToken } from './auth'
import {
  onV2, v2Status, v2Enabled, getV2UserBooks, getV2UserBook, getV2UserBookChapter, removeV2Book, v2FileUrl,
  readV2Progress, saveV2Progress, uploadV2Book, V2UploadError, completeV2Book, uncompleteV2Book, type V2WriteOutcome,
} from './v2'

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

export interface UserBookDetail {
  id: string
  title: string
  slug: string
  language: string
  author: string | null
  description: string | null
  coverPath: string | null
  genre: string | null
  publishedYear: number | null
  totalWordCount: number | null
  status: 'Processing' | 'Ready' | 'Failed'
  errorMessage: string | null
  chapters: UserChapterSummary[]
  toc: TocEntry[] | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  /** True when the original upload is a PDF that can be rendered pixel-perfect
   *  in the opt-in "Original layout" view. Absent on older payloads → false. */
  hasOriginalPdf?: boolean
  /** LLM metadata enrichment lifecycle (genre/year/description generation).
   *  "NotStarted" | "Pending" | "Running" | "Completed" | "Failed".
   *  Absent on older payloads → treat as no enrichment in flight. */
  metadataEnrichmentStatus?: string
  /** Page a clipped article came from. Null for uploaded files; absent on older payloads. */
  sourceUrl?: string | null
  /** PDF-2: the PDF's real page count; null/absent → estimate from words. */
  pageCount?: number | null
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
  /** Largest single request body the platform accepts; bigger uploads go in parts. */
  maxSingleUploadBytes?: number
}

// Cloudflare refuses any single request body over ~100 MB with a 413 before it reaches the API; the server
// reports its own ceiling as maxSingleUploadBytes. Bigger files go up as parts and are joined server-side.
const DEFAULT_MAX_SINGLE_UPLOAD = 80 * 1024 * 1024
const MAX_PART_BYTES = 50 * 1024 * 1024

class UploadError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message)
  }
}

function uploadError(xhr: XMLHttpRequest): UploadError {
  let body: unknown
  try { body = JSON.parse(xhr.responseText) } catch {}
  if (xhr.status === 413) return new UploadError('File is too large to upload. Try a smaller file.', 413, body)
  let error = `Upload failed: ${xhr.status}`
  if ((body as { error?: string } | undefined)?.error) error = (body as { error: string }).error
  return new UploadError(error, xhr.status, body)
}

/** A V2 part: the same XHR send (progress, one retry); a 413 is the quota (`current` = `{used, limit}`). */
async function sendV2Part(url: string, part: Blob, onLoaded: (loaded: number) => void): Promise<void> {
  try {
    await withOneRetry(() => send('PUT', url, part, onLoaded, 'application/octet-stream'))
  } catch (err) {
    if (err instanceof UploadError && err.status === 413) {
      throw new V2UploadError('quota_exceeded', (err.body as { current?: { used: number; limit: number } } | undefined)?.current)
    }
    throw err
  }
}

function send(
  method: string,
  url: string,
  body: XMLHttpRequestBodyInit | null,
  onLoaded?: (loadedBytes: number, totalBytes: number | null) => void,
  contentType?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.upload.addEventListener('progress', (e) => onLoaded?.(e.loaded, e.lengthComputable ? e.total : null))
    xhr.addEventListener('load', () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.responseText) : reject(uploadError(xhr)))
    xhr.addEventListener('error', () => reject(new UploadError('Upload failed', 0)))
    xhr.open(method, url)
    xhr.withCredentials = true
    if (contentType) xhr.setRequestHeader('Content-Type', contentType)
    xhr.send(body)
  })
}

async function uploadInParts(
  file: File,
  partBytes: number,
  title?: string,
  language?: string,
  onProgress?: (percent: number) => void
): Promise<UploadResponse> {
  const base = `${API_BASE}/me/books/uploads/${crypto.randomUUID()}`
  const partCount = Math.ceil(file.size / partBytes)
  try {
    for (let i = 0; i < partCount; i++) {
      const start = i * partBytes
      const blob = file.slice(start, Math.min(start + partBytes, file.size))
      await withOneRetry(() => send('PUT', `${base}/parts/${i}`, blob,
        (loaded) => onProgress?.(((start + loaded) / file.size) * 100), 'application/octet-stream'))
    }
    const body = JSON.stringify({ fileName: file.name, partCount, title: title ?? null, language: language ?? null })
    // Never retried: the first attempt claims the parts, so a retry can only fail — and the book may
    // already exist if just the response was lost.
    return JSON.parse(await send('POST', `${base}/complete`, body, undefined, 'application/json'))
  } catch (err) {
    // Free the parts already on the server; best effort — they are swept after a day anyway.
    send('DELETE', base, null).catch(() => {})
    throw err
  }
}

// The `user-upload` limiter's window (per IP, 20 requests/min); a 429 waits it out once.
export const RATE_LIMIT_WAIT_MS = 60_000

// A part can outlive the access cookie on a slow link (single POSTs auth once, up front): a 401 refreshes
// the cookie and retries; a 429 waits for the limiter window; a dropped connection or 5xx retries once.
// Any other 4xx is final.
async function withOneRetry(request: () => Promise<string>): Promise<string> {
  try {
    return await request()
  } catch (err) {
    const status = err instanceof UploadError ? err.status : 0
    if (status === 401) await refreshToken()
    else if (status === 429) await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS))
    else if (status >= 400 && status < 500) throw err
    return request()
  }
}

export async function uploadUserBook(
  file: File,
  title?: string,
  language?: string,
  onProgress?: (percent: number) => void
): Promise<UploadResponse & { existing?: boolean }> {
  const v2 = await v2Status()
  if (v2.enabled) {
    const result = await uploadV2Book(file, v2.maxPartBytes, sendV2Part, onProgress)
    if (!result.existing) trackBookUploaded({ format: (file.name.split('.').pop() || '').toLowerCase() || 'unknown', sizeBytes: file.size })
    return result
  }
  // Only a big file pays for the quota round-trip that tells us the server's ceiling.
  const maxSingle = file.size > DEFAULT_MAX_SINGLE_UPLOAD
    ? (await getStorageQuota().catch(() => null))?.maxSingleUploadBytes ?? DEFAULT_MAX_SINGLE_UPLOAD
    : DEFAULT_MAX_SINGLE_UPLOAD

  let result: UploadResponse
  if (file.size > maxSingle) {
    result = await uploadInParts(file, Math.min(maxSingle, MAX_PART_BYTES), title, language, onProgress)
  } else {
    const formData = new FormData()
    formData.append('file', file)
    if (title) formData.append('title', title)
    if (language) formData.append('language', language)
    result = JSON.parse(await send('POST', `${API_BASE}/me/books/upload`, formData,
      (loaded, total) => { if (total) onProgress?.((loaded / total) * 100) }))
  }

  // GA4: conversion signal — users who upload their own book are far
  // more valuable than passive catalog readers. Derive format from
  // extension since MIME for .epub is inconsistent across browsers.
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  trackBookUploaded({ format: ext || 'unknown', sizeBytes: file.size })
  return result
}

export interface GetUserBooksOptions {
  /** 'readlater' → only web clips (Read later shelf). Omit → Books tab (excludes clips). */
  shelf?: 'readlater'
  /** 'unread' → only unread books (applied within the chosen shelf). */
  status?: 'unread'
}

export async function getUserBooks(opts?: GetUserBooksOptions): Promise<UserBook[]> {
  // V2 has no clips: the Read later shelf is empty there.
  if (await onV2()) return opts?.shelf ? [] : getV2UserBooks()
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
  if (await onV2()) return getV2UserBook(id)
  return authFetch<UserBookDetail>(`/me/books/${id}`)
}

export async function getUserBookChapter(bookId: string, slug: string): Promise<UserChapter> {
  if (await onV2()) return getV2UserBookChapter(bookId, slug)
  return authFetch<UserChapter>(`/me/books/${bookId}/chapters/${slug}`)
}

export async function deleteUserBook(id: string): Promise<void> {
  if (await onV2()) return removeV2Book(id)
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
  if (await onV2()) return completeV2Book(id)
  await authFetch<void>(`/me/books/${id}/complete`, { method: 'POST' })
}

export async function unmarkUserBookComplete(id: string): Promise<void> {
  if (await onV2()) return uncompleteV2Book(id)
  await authFetch<void>(`/me/books/${id}/complete`, { method: 'DELETE' })
}

export async function getStorageQuota(): Promise<StorageQuota> {
  // V2 serves no quota until an upload hits it (413 `quota_exceeded` carries used/limit): the line is hidden.
  if (await onV2()) throw new ApiError(404, 'No storage quota on V2')
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
  // A V2 cover is already an absolute URL (the API's cover route), not a storage path.
  if (/^https?:\/\//.test(coverPath)) return coverPath
  return `${API_BASE}/storage/${coverPath}`
}

/**
 * URL of the original uploaded PDF (Range-enabled) for the Original-layout view.
 * Cookie-authed same-origin; pass to pdf.js via `getDocument({ url, withCredentials: true })`.
 */
export function getUserBookFileUrl(id: string): string {
  if (v2Enabled()) return v2FileUrl(id)
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

/** A bulk action on V2: one request per book (no bulk routes), the legacy result shape. */
async function eachV2(ids: string[], action: (id: string) => Promise<void>): Promise<BulkResult> {
  const result: BulkResult = { succeeded: [], failed: [] }
  for (const id of ids) {
    try {
      await action(id)
      result.succeeded.push(id)
    } catch (e) {
      result.failed.push({ id, reason: e instanceof Error ? e.message : 'failed' })
    }
  }
  return result
}

export async function bulkFinishUserBooks(ids: string[], isFinished: boolean): Promise<BulkResult> {
  if (await onV2()) return eachV2(ids, isFinished ? completeV2Book : uncompleteV2Book)
  return authFetch<BulkResult>('/me/books/bulk/finish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, isFinished }),
  })
}

export async function bulkDeleteUserBooks(ids: string[]): Promise<BulkResult> {
  if (await onV2()) return eachV2(ids, removeV2Book)
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
/** The progress row both clients restore from (`@textstack/shared`). */
export type UserBookProgress = UserBookProgressDto

export async function getUserBookProgress(bookId: string): Promise<UserBookProgress | null> {
  return (await readUserBookProgress(bookId)) ?? null
}

/** The reader's read: `null` answered with nothing, `undefined` no answer — see `readProgress`
 *  in api/auth.ts. */
export async function readUserBookProgress(bookId: string, signal?: AbortSignal): Promise<UserBookProgress | null | undefined> {
  if (await onV2()) return readV2Progress(bookId, signal)
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
): Promise<V2WriteOutcome | void> {
  // V2: the revision rule decides; the outcome says whether the reader adopts the server's place or reloads.
  if (await onV2()) return saveV2Progress(bookId, data)
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
  // V2 has no bookmarks (ADR-031): nothing to load for a V2 book.
  if (await onV2()) return []
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
