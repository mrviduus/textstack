import type { UserBookDetailResponse, UserBookProgressDto } from '@textstack/shared'
import { trackBookUploaded } from '../lib/analytics'
import { refreshToken } from './auth'
import {
  syncSwitch, startSyncProbe, pullBooks, getShelfBooks, getBookDetail, removeBook, originalFileUrl,
  readBookProgress, uploadBook, FileUploadError, completeBook, uncompleteBook, type MarkOutcome,
} from './sync'

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
  /** True when the original upload is a PDF → the card can open "Original layout"
   *  instantly. Absent on older payloads → false. */
  hasOriginalPdf?: boolean
}

export interface TocEntry {
  title: string
  chapterNumber: number | null
  children: TocEntry[] | null
}

/** The book-detail shape (`@textstack/shared`), its TOC typed. */
export type UserBookDetail = Omit<UserBookDetailResponse, 'toc'> & { toc: TocEntry[] | null }

export interface UploadResponse {
  userBookId: string
  jobId: string
  status: string
  /** True the instant a PDF lands (file stored at upload) → redirect can open
   *  "Original layout" before extraction finishes. Absent on older payloads → false. */
  hasOriginalPdf?: boolean
}

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
async function sendPart(url: string, part: Blob, onLoaded: (loaded: number) => void): Promise<void> {
  try {
    await withOneRetry(() => send('PUT', url, part, onLoaded, 'application/octet-stream'))
  } catch (err) {
    if (err instanceof UploadError && err.status === 413) {
      throw new FileUploadError('quota_exceeded', (err.body as { current?: { used: number; limit: number } } | undefined)?.current)
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
  onProgress?: (percent: number) => void
): Promise<UploadResponse & { existing?: boolean }> {
  let server = await syncSwitch()
  if (!server.enabled) server = await startSyncProbe() // a failed probe is asked again
  if (!server.enabled) throw new UploadError('Upload failed: the server is unavailable, try again later', 503)
  const result = await uploadBook(file, server.maxPartBytes, sendPart, onProgress)
  if (!result.existing) trackBookUploaded({ format: (file.name.split('.').pop() || '').toLowerCase() || 'unknown', sizeBytes: file.size })
  return result
}

export function getUserBooks(): Promise<UserBook[]> {
  return getShelfBooks()
}

export function getUserBook(id: string): Promise<UserBookDetail> {
  return getBookDetail(id)
}

export function deleteUserBook(id: string): Promise<void> {
  return removeBook(id)
}

export function markUserBookComplete(id: string): Promise<MarkOutcome> {
  return completeBook(id)
}

export function unmarkUserBookComplete(id: string): Promise<MarkOutcome> {
  return uncompleteBook(id)
}

export function getUserBookCoverUrl(coverPath: string | null | undefined): string | undefined {
  // A cover is already a URL (the API's owner-checked cover route, sync.ts); /storage serves no upload (#956).
  return coverPath || undefined
}

/** URL of the book's current file (Range-enabled), cookie-authed same-origin. */
export function getUserBookFileUrl(id: string): string {
  return originalFileUrl(id)
}

// Tags API
export interface TagCount {
  tag: string
  count: number
}

/** The uploads' tags, counted from the library feed. */
export async function getUserTags(): Promise<TagCount[]> {
  const counts = new Map<string, number>()
  for (const b of await pullBooks()) if (!b.removedAt) for (const t of b.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

// Bulk actions
export interface BulkResult {
  succeeded: string[]
  failed: { id: string; reason: string }[]
}

/** A bulk action: one request per book (no bulk routes). */
async function eachBook(ids: string[], action: (id: string) => Promise<unknown>): Promise<BulkResult> {
  const result: BulkResult = { succeeded: [], failed: [] }
  for (const [i, id] of ids.entries()) {
    try {
      if ((await action(id)) === 'dropped') {
        // Signed out meanwhile: every write left would be dropped too.
        result.failed.push(...ids.slice(i).map((rest) => ({ id: rest, reason: 'dropped' })))
        break
      }
      result.succeeded.push(id)
    } catch (e) {
      result.failed.push({ id, reason: e instanceof Error ? e.message : 'failed' })
    }
  }
  return result
}

export function bulkFinishUserBooks(ids: string[], isFinished: boolean): Promise<BulkResult> {
  return eachBook(ids, isFinished ? completeBook : uncompleteBook)
}

export function bulkDeleteUserBooks(ids: string[]): Promise<BulkResult> {
  return eachBook(ids, removeBook)
}

// Progress API
/** The progress row both clients restore from (`@textstack/shared`). */
export type UserBookProgress = UserBookProgressDto

export async function getUserBookProgress(bookId: string): Promise<UserBookProgress | null> {
  return (await readUserBookProgress(bookId)) ?? null
}

/** The reader's read: `null` answered with nothing, `undefined` no answer. */
export function readUserBookProgress(bookId: string, signal?: AbortSignal): Promise<UserBookProgress | null | undefined> {
  return readBookProgress(bookId, signal)
}

