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
