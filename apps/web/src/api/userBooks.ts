const API_BASE = import.meta.env.VITE_API_URL ?? ''

export interface UserBook {
  id: string
  title: string
  slug: string
  language: string
  description: string | null
  coverPath: string | null
  status: 'Processing' | 'Ready' | 'Failed'
  chapterCount: number
  createdAt: string
}

export interface UserChapterSummary {
  id: string
  chapterNumber: number
  title: string
  wordCount: number | null
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
  description: string | null
  coverPath: string | null
  status: 'Processing' | 'Ready' | 'Failed'
  errorMessage: string | null
  chapters: UserChapterSummary[]
  toc: TocEntry[] | null
  createdAt: string
  updatedAt: string
}

export interface UserChapter {
  id: string
  chapterNumber: number
  title: string
  html: string
  wordCount: number | null
  previous: { chapterNumber: number; title: string } | null
  next: { chapterNumber: number; title: string } | null
}

export interface UploadResponse {
  userBookId: string
  jobId: string
  status: string
}

export interface StorageQuota {
  usedBytes: number
  limitBytes: number
  usedPercent: number
}

async function authFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
  })

  if (!res.ok) {
    if (res.status === 401) throw new Error('Unauthorized')
    const text = await res.text()
    let error = `API error: ${res.status}`
    try {
      const json = JSON.parse(text)
      if (json.error) error = json.error
    } catch {}
    throw new Error(error)
  }

  const text = await res.text()
  if (!text) return {} as T
  return JSON.parse(text)
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

export async function getUserBooks(): Promise<UserBook[]> {
  return authFetch<UserBook[]>('/me/books')
}

export async function getUserBook(id: string): Promise<UserBookDetail> {
  return authFetch<UserBookDetail>(`/me/books/${id}`)
}

export async function getUserBookChapter(bookId: string, chapterNumber: number): Promise<UserChapter> {
  return authFetch<UserChapter>(`/me/books/${bookId}/chapters/${chapterNumber}`)
}

export async function deleteUserBook(id: string): Promise<void> {
  await authFetch<void>(`/me/books/${id}`, { method: 'DELETE' })
}

export async function getStorageQuota(): Promise<StorageQuota> {
  return authFetch<StorageQuota>('/me/books/quota')
}

export function getUserBookCoverUrl(coverPath: string | null | undefined): string | undefined {
  if (!coverPath) return undefined
  return `${API_BASE}/storage/${coverPath}`
}
