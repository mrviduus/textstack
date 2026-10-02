import { authFetch } from './client'
import type { UserLibraryItem } from '../types/api'

export async function getLibrary() {
  const res = await authFetch<{ total: number; items: UserLibraryItem[] }>('/me/library')
  return res.items
}

export function addToLibrary(editionId: string) {
  return authFetch<void>(`/me/library/${editionId}`, { method: 'POST' })
}

export function removeFromLibrary(editionId: string) {
  return authFetch<void>(`/me/library/${editionId}`, { method: 'DELETE' })
}

export interface LibraryShelfItem {
  id: string
  type: 'userbook' | 'savedbook'
  title: string
  author: string | null
  coverPath: string | null
  slug: string | null
  language: string | null
  progressPercent: number
  lastOpenedAt: string | null
  createdAt: string
  estimatedMinutesRemaining: number | null
  /** Chapter the reader stopped in (continue-reading target). Null for a
   *  chapterless PDF or an unopened book; absent on older payloads. */
  chapterSlug?: string | null
}

export interface LibraryShelves {
  continueReading: LibraryShelfItem[]
  recentlyAdded: LibraryShelfItem[]
  quickReads: LibraryShelfItem[]
  finishedThisMonth: LibraryShelfItem[]
}

export function getLibraryShelves(): Promise<LibraryShelves> {
  return authFetch<LibraryShelves>('/me/library/shelves')
}
