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

export type HighlightColor = 'yellow' | 'green' | 'pink' | 'blue'

export interface TextAnchor {
  prefix: string
  exact: string
  suffix: string
  startOffset: number
  endOffset: number
  chapterId: string
}

export interface StoredHighlight {
  id: string
  editionId: string
  chapterId: string
  anchor: TextAnchor
  color: HighlightColor
  selectedText: string
  noteText?: string
  syncStatus: 'pending' | 'synced'
  version: number
  createdAt: number
  updatedAt: number
}

export interface CachedTranslation {
  key: string // `${sourceLang}:${targetLang}:${textHash}`
  sourceText: string
  translatedText: string
  sourceLang: string
  targetLang: string
  cachedAt: number
}

export interface DictionaryDefinition {
  partOfSpeech: string
  definitions: {
    definition: string
    example?: string
  }[]
}

export interface CachedDictionaryEntry {
  key: string // `${lang}:${word}`
  word: string
  lang: string
  phonetic?: string
  definitions: DictionaryDefinition[]
  cachedAt: number
}

const DB_NAME = 'textstack-reader'
const DB_VERSION = 5
const CHAPTERS_STORE = 'chapters'
const BOOKS_META_STORE = 'cachedBooks'
const HIGHLIGHTS_STORE = 'highlights'
const TRANSLATIONS_STORE = 'translations'
const DICTIONARY_STORE = 'dictionary'

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

      // Highlights store (v3)
      if (!db.objectStoreNames.contains(HIGHLIGHTS_STORE)) {
        const store = db.createObjectStore(HIGHLIGHTS_STORE, { keyPath: 'id' })
        store.createIndex('editionId', 'editionId', { unique: false })
        store.createIndex('chapterId', 'chapterId', { unique: false })
        store.createIndex('editionChapter', ['editionId', 'chapterId'], { unique: false })
      }

      // Translations cache store (v4)
      if (!db.objectStoreNames.contains(TRANSLATIONS_STORE)) {
        const store = db.createObjectStore(TRANSLATIONS_STORE, { keyPath: 'key' })
        store.createIndex('cachedAt', 'cachedAt', { unique: false })
      }

      // Dictionary cache store (v5)
      if (!db.objectStoreNames.contains(DICTIONARY_STORE)) {
        const store = db.createObjectStore(DICTIONARY_STORE, { keyPath: 'key' })
        store.createIndex('cachedAt', 'cachedAt', { unique: false })
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

// ============ HIGHLIGHTS ============

export async function getHighlightsForEdition(
  editionId: string
): Promise<StoredHighlight[]> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(HIGHLIGHTS_STORE, 'readonly')
    const store = tx.objectStore(HIGHLIGHTS_STORE)
    const index = store.index('editionId')
    const request = index.getAll(editionId)

    request.onsuccess = () => {
      const highlights = request.result as StoredHighlight[]
      highlights.sort((a, b) => b.createdAt - a.createdAt)
      resolve(highlights)
    }
    request.onerror = () => reject(request.error)
  })
}

export async function getHighlightsForChapter(
  editionId: string,
  chapterId: string
): Promise<StoredHighlight[]> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(HIGHLIGHTS_STORE, 'readonly')
    const store = tx.objectStore(HIGHLIGHTS_STORE)
    const index = store.index('editionChapter')
    const request = index.getAll([editionId, chapterId])

    request.onsuccess = () => {
      const highlights = request.result as StoredHighlight[]
      highlights.sort((a, b) => a.anchor.startOffset - b.anchor.startOffset)
      resolve(highlights)
    }
    request.onerror = () => reject(request.error)
  })
}

export async function getHighlightById(
  id: string
): Promise<StoredHighlight | null> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(HIGHLIGHTS_STORE, 'readonly')
    const store = tx.objectStore(HIGHLIGHTS_STORE)
    const request = store.get(id)

    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

export async function saveHighlight(
  highlight: StoredHighlight
): Promise<StoredHighlight> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(HIGHLIGHTS_STORE, 'readwrite')
    const store = tx.objectStore(HIGHLIGHTS_STORE)
    const request = store.put(highlight)

    request.onsuccess = () => resolve(highlight)
    request.onerror = () => reject(request.error)
  })
}

export async function deleteHighlight(id: string): Promise<void> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(HIGHLIGHTS_STORE, 'readwrite')
    const store = tx.objectStore(HIGHLIGHTS_STORE)
    const request = store.delete(id)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function deleteHighlightsByEdition(editionId: string): Promise<void> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(HIGHLIGHTS_STORE, 'readwrite')
    const store = tx.objectStore(HIGHLIGHTS_STORE)
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

export async function getPendingHighlights(): Promise<StoredHighlight[]> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(HIGHLIGHTS_STORE, 'readonly')
    const store = tx.objectStore(HIGHLIGHTS_STORE)
    const request = store.getAll()

    request.onsuccess = () => {
      const highlights = (request.result as StoredHighlight[]).filter(
        (h) => h.syncStatus === 'pending'
      )
      resolve(highlights)
    }
    request.onerror = () => reject(request.error)
  })
}

// ============ TRANSLATIONS CACHE ============

function hashText(text: string): string {
  // Simple hash for cache key
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return hash.toString(36)
}

function makeTranslationKey(sourceLang: string, targetLang: string, text: string): string {
  return `${sourceLang}:${targetLang}:${hashText(text)}`
}

export async function getCachedTranslation(
  sourceLang: string,
  targetLang: string,
  text: string
): Promise<CachedTranslation | null> {
  const db = await openOfflineDb()
  const key = makeTranslationKey(sourceLang, targetLang, text)

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSLATIONS_STORE, 'readonly')
    const store = tx.objectStore(TRANSLATIONS_STORE)
    const request = store.get(key)

    request.onsuccess = () => {
      const result = request.result as CachedTranslation | undefined
      // Check cache validity (7 days)
      if (result && Date.now() - result.cachedAt < 7 * 24 * 60 * 60 * 1000) {
        resolve(result)
      } else {
        resolve(null)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

export async function cacheTranslation(
  sourceLang: string,
  targetLang: string,
  sourceText: string,
  translatedText: string
): Promise<void> {
  const db = await openOfflineDb()
  const cached: CachedTranslation = {
    key: makeTranslationKey(sourceLang, targetLang, sourceText),
    sourceText,
    translatedText,
    sourceLang,
    targetLang,
    cachedAt: Date.now(),
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSLATIONS_STORE, 'readwrite')
    const store = tx.objectStore(TRANSLATIONS_STORE)
    const request = store.put(cached)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function clearOldTranslations(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const db = await openOfflineDb()
  const cutoff = Date.now() - maxAgeMs

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRANSLATIONS_STORE, 'readwrite')
    const store = tx.objectStore(TRANSLATIONS_STORE)
    const index = store.index('cachedAt')
    const range = IDBKeyRange.upperBound(cutoff)
    const request = index.openCursor(range)

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

// ============ DICTIONARY CACHE ============

function makeDictionaryKey(lang: string, word: string): string {
  return `${lang}:${word.toLowerCase()}`
}

export async function getCachedDictionaryEntry(
  lang: string,
  word: string
): Promise<CachedDictionaryEntry | null> {
  const db = await openOfflineDb()
  const key = makeDictionaryKey(lang, word)

  return new Promise((resolve, reject) => {
    const tx = db.transaction(DICTIONARY_STORE, 'readonly')
    const store = tx.objectStore(DICTIONARY_STORE)
    const request = store.get(key)

    request.onsuccess = () => {
      const result = request.result as CachedDictionaryEntry | undefined
      // Check cache validity (30 days)
      if (result && Date.now() - result.cachedAt < 30 * 24 * 60 * 60 * 1000) {
        resolve(result)
      } else {
        resolve(null)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

export async function cacheDictionaryEntry(
  lang: string,
  word: string,
  phonetic: string | undefined,
  definitions: DictionaryDefinition[]
): Promise<void> {
  const db = await openOfflineDb()
  const cached: CachedDictionaryEntry = {
    key: makeDictionaryKey(lang, word),
    word: word.toLowerCase(),
    lang,
    phonetic,
    definitions,
    cachedAt: Date.now(),
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(DICTIONARY_STORE, 'readwrite')
    const store = tx.objectStore(DICTIONARY_STORE)
    const request = store.put(cached)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function clearOldDictionaryEntries(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<void> {
  const db = await openOfflineDb()
  const cutoff = Date.now() - maxAgeMs

  return new Promise((resolve, reject) => {
    const tx = db.transaction(DICTIONARY_STORE, 'readwrite')
    const store = tx.objectStore(DICTIONARY_STORE)
    const index = store.index('cachedAt')
    const range = IDBKeyRange.upperBound(cutoff)
    const request = index.openCursor(range)

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
