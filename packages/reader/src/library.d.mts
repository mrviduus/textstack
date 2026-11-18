// Types for library.mjs: apps/web type-checks it without allowJs (the R5 dev route), mobile gets the same shape.
export interface LibraryEntry {
  id: string
  sha256: string
  size: number
  title: string
  author: string
  originalName: string
  importedAt: number
  openedAt: number
}
export interface Library {
  v: number
  books: LibraryEntry[]
}
export interface OpenedBook {
  sha256: string
  size: number
  title?: string
  author?: string
  originalName: string
}

export const LIBRARY_VERSION: 1
export function parseLibrary(json: string): Library | null
export function emptyLibrary(): Library
export function addOpened(lib: Library, book: OpenedBook, now?: number, newId?: () => string): { lib: Library; entry: LibraryEntry; existing: boolean }
export function touch(lib: Library, id: string, now?: number): Library
