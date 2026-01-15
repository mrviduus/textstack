import type { Chapter, ChapterNav } from '../types/api'

export interface CachedChapter {
  key: string // `${editionId}:${chapterSlug}`
  editionId: string
  chapterSlug: string
  html: string
  title: string
  wordCount: number | null
  prev: ChapterNav | null
  next: ChapterNav | null
  cachedAt: number
}

export interface CachedBookMeta {
  editionId: string
  slug: string
  totalChapters: number
  cachedChapters: number
  cachedAt: number
}

const DB_NAME = 'textstack-reader'
const DB_VERSION = 2
const CHAPTERS_STORE = 'chapters'
const BOOKS_META_STORE = 'cachedBooks'

let dbPromise: Promise<IDBDatabase> | null = null

export function openOfflineDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      // Existing bookmarks store (from v1)
      if (!db.objectStoreNames.contains('bookmarks')) {
        const store = db.createObjectStore('bookmarks', { keyPath: 'id' })
        store.createIndex('bookId', 'bookId', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }

      // New chapters store (v2)
      if (!db.objectStoreNames.contains(CHAPTERS_STORE)) {
        const store = db.createObjectStore(CHAPTERS_STORE, { keyPath: 'key' })
        store.createIndex('editionId', 'editionId', { unique: false })
      }

      // New cached books metadata store (v2)
      if (!db.objectStoreNames.contains(BOOKS_META_STORE)) {
        db.createObjectStore(BOOKS_META_STORE, { keyPath: 'editionId' })
      }
    }
  })

  return dbPromise
}

function makeChapterKey(editionId: string, chapterSlug: string): string {
  return `${editionId}:${chapterSlug}`
}

// ============ CHAPTERS ============

export async function getCachedChapter(
  editionId: string,
  chapterSlug: string
): Promise<CachedChapter | null> {
  const db = await openOfflineDb()
  const key = makeChapterKey(editionId, chapterSlug)

  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAPTERS_STORE, 'readonly')
    const store = tx.objectStore(CHAPTERS_STORE)
    const request = store.get(key)

    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

export async function cacheChapter(
  editionId: string,
  chapter: Chapter
): Promise<void> {
  const db = await openOfflineDb()
  const cached: CachedChapter = {
    key: makeChapterKey(editionId, chapter.slug),
    editionId,
    chapterSlug: chapter.slug,
    html: chapter.html,
    title: chapter.title,
    wordCount: chapter.wordCount,
    prev: chapter.prev,
    next: chapter.next,
    cachedAt: Date.now(),
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAPTERS_STORE, 'readwrite')
    const store = tx.objectStore(CHAPTERS_STORE)
    const request = store.put(cached)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function deleteChaptersByEdition(editionId: string): Promise<void> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAPTERS_STORE, 'readwrite')
    const store = tx.objectStore(CHAPTERS_STORE)
    const index = store.index('editionId')
    const request = index.openCursor(IDBKeyRange.only(editionId))

    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      } else {
        resolve()
      }
    }
    request.onerror = () => reject(request.error)
  })
}

export async function countCachedChapters(editionId: string): Promise<number> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAPTERS_STORE, 'readonly')
    const store = tx.objectStore(CHAPTERS_STORE)
    const index = store.index('editionId')
    const request = index.count(IDBKeyRange.only(editionId))

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// ============ BOOK META ============

export async function getCachedBookMeta(
  editionId: string
): Promise<CachedBookMeta | null> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKS_META_STORE, 'readonly')
    const store = tx.objectStore(BOOKS_META_STORE)
    const request = store.get(editionId)

    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

export async function setCachedBookMeta(meta: CachedBookMeta): Promise<void> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKS_META_STORE, 'readwrite')
    const store = tx.objectStore(BOOKS_META_STORE)
    const request = store.put(meta)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function deleteCachedBookMeta(editionId: string): Promise<void> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKS_META_STORE, 'readwrite')
    const store = tx.objectStore(BOOKS_META_STORE)
    const request = store.delete(editionId)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

// ============ CLEANUP ============

export async function deleteAllCachedData(editionId: string): Promise<void> {
  await Promise.all([
    deleteChaptersByEdition(editionId),
    deleteCachedBookMeta(editionId),
  ])
}

export async function isBookFullyCached(editionId: string): Promise<boolean> {
  const meta = await getCachedBookMeta(editionId)
  if (!meta) return false
  return meta.cachedChapters >= meta.totalChapters
}
