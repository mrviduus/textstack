import type { Chapter, ChapterNav } from '../types/api'
import { translationApi, type PdfAnchor } from '@textstack/shared'

export interface CachedChapter {
  key: string // `${editionId}:${chapterSlug}`
  /** The server chapter id. Absent on rows cached before it was stored. */
  chapterId?: string
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

// Reflow highlights carry a text-offset TextAnchor; Original-layout PDF
// highlights carry a quad-rect PdfAnchor (discriminated by `kind:"pdf"`).
export type HighlightAnchor = TextAnchor | PdfAnchor

export interface StoredHighlight {
  id: string
  editionId: string
  chapterId: string
  userBookId?: string
  userChapterId?: string
  anchor: HighlightAnchor
  color: HighlightColor
  selectedText: string
  noteText?: string
  syncStatus: 'pending' | 'synced'
  /** The note was edited or cleared while pending, so replay must send it. Without it replay
   *  leaves the server's note alone — it may have been written on another device. */
  noteEdited?: boolean
  /** The last server-synced state, captured when a synced row first goes pending. Replay
   *  three-way-merges against it (highlightSync.replayUpdateBody): a field the server changed
   *  since `base` is someone else's edit and is not overwritten. Absent on rows that have
   *  never been on the server, and on pending rows written before it existed. */
  base?: { version: number; color: HighlightColor; noteText?: string }
  /** Tombstone: deleted locally, server delete not yet confirmed. Hidden from the UI. */
  deleted?: boolean
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

export interface CachedTtsAudio {
  key: string // `${lang}:${hash(text)}`
  audioData: ArrayBuffer
  lang: string
  cachedAt: number
}

export interface CachedExplain {
  key: string // hash of word+sentence+genre+targetLang
  explanation: string
  word: string
  targetLang: string
  cachedAt: number
}

export interface PendingVocabWord {
  id: string           // crypto.randomUUID(), stable local ID
  word: string
  language: string
  translation?: string | null
  definition?: string | null
  editionId?: string | null
  chapterId?: string | null
  userBookId?: string | null
  sentence?: string | null
  bookTitle?: string | null
  nativeLanguage?: string | null
  createdAt: number    // epoch ms, FIFO flush order
}

const DB_NAME = 'textstack-reader'
const DB_VERSION = 10
const CHAPTERS_STORE = 'chapters'
const BOOKS_META_STORE = 'cachedBooks'
const HIGHLIGHTS_STORE = 'highlights'
const TRANSLATIONS_STORE = 'translations'
const TTS_STORE = 'tts-audio'
const PENDING_VOCAB_STORE = 'pendingVocabWords'
const EXPLAIN_STORE = 'explains'

let dbPromise: Promise<IDBDatabase> | null = null

export function openOfflineDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      // A newer tab is upgrading the schema: step aside rather than block it (until reload).
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }

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

      // Add userBookId index to highlights (v7)
      if (db.objectStoreNames.contains(HIGHLIGHTS_STORE)) {
        const tx = (event.target as IDBOpenDBRequest).transaction!
        const store = tx.objectStore(HIGHLIGHTS_STORE)
        if (!store.indexNames.contains('userBookId')) {
          store.createIndex('userBookId', 'userBookId', { unique: false })
        }
      }

      // Translations cache store (v4)
      if (!db.objectStoreNames.contains(TRANSLATIONS_STORE)) {
        const store = db.createObjectStore(TRANSLATIONS_STORE, { keyPath: 'key' })
        store.createIndex('cachedAt', 'cachedAt', { unique: false })
      }

      // Dictionary cache store (v5) — the dictionary was removed 2026-10-03; dropped in v10.
      if (db.objectStoreNames.contains('dictionary')) {
        db.deleteObjectStore('dictionary')
      }

      // TTS audio cache store (v6)
      if (!db.objectStoreNames.contains(TTS_STORE)) {
        const store = db.createObjectStore(TTS_STORE, { keyPath: 'key' })
        store.createIndex('cachedAt', 'cachedAt', { unique: false })
      }

      // Pending vocab words store (v8) — anonymous accumulation before guest-create threshold.
      if (!db.objectStoreNames.contains(PENDING_VOCAB_STORE)) {
        const store = db.createObjectStore(PENDING_VOCAB_STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }

      // Explain cache store (v9) — mirrors server-side file cache for zero-latency repeat lookups.
      if (!db.objectStoreNames.contains(EXPLAIN_STORE)) {
        const store = db.createObjectStore(EXPLAIN_STORE, { keyPath: 'key' })
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
    chapterId: chapter.id,
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

// ============ CLEANUP ============

async function deleteChaptersByEdition(editionId: string): Promise<void> {
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

async function deleteCachedBookMeta(editionId: string): Promise<void> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKS_META_STORE, 'readwrite')
    const store = tx.objectStore(BOOKS_META_STORE)
    const request = store.delete(editionId)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function deleteAllCachedData(editionId: string): Promise<void> {
  await Promise.all([
    deleteChaptersByEdition(editionId),
    deleteCachedBookMeta(editionId),
  ])
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

export async function getAllStoredHighlights(): Promise<StoredHighlight[]> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const request = db.transaction(HIGHLIGHTS_STORE, 'readonly').objectStore(HIGHLIGHTS_STORE).getAll()
    request.onsuccess = () => resolve(request.result as StoredHighlight[])
    request.onerror = () => reject(request.error)
  })
}

export async function getHighlightsForUserBook(
  userBookId: string
): Promise<StoredHighlight[]> {
  const db = await openOfflineDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(HIGHLIGHTS_STORE, 'readonly')
    const store = tx.objectStore(HIGHLIGHTS_STORE)
    const index = store.index('userBookId')
    const request = index.getAll(userBookId)

    request.onsuccess = () => {
      const highlights = request.result as StoredHighlight[]
      highlights.sort((a, b) => b.createdAt - a.createdAt)
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

// One key rule with mobile (`translateCacheKey`): derived from the request body, so it varies
// exactly as the server's answer can — sentence for a word / short phrase only, and bookId.
// The full string, not hashText: with sentence + book in it there are enough entries for a
// 32-bit collision to serve one word another's translation.
export function makeTranslationKey(sourceLang: string, targetLang: string, text: string, sentence?: string | null, bookId?: string | null): string {
  return translationApi.translateCacheKey(text, sourceLang, targetLang, { sentence, bookId })
}

export async function getCachedTranslation(
  sourceLang: string,
  targetLang: string,
  text: string,
  sentence?: string | null,
  bookId?: string | null
): Promise<CachedTranslation | null> {
  const db = await openOfflineDb()
  const key = makeTranslationKey(sourceLang, targetLang, text, sentence, bookId)

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
  translatedText: string,
  sentence?: string | null,
  bookId?: string | null
): Promise<void> {
  const db = await openOfflineDb()
  const cached: CachedTranslation = {
    key: makeTranslationKey(sourceLang, targetLang, sourceText, sentence, bookId),
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

async function deleteOlderThan(storeName: string, maxAgeMs: number): Promise<void> {
  const db = await openOfflineDb()
  const range = IDBKeyRange.upperBound(Date.now() - maxAgeMs)

  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readwrite').objectStore(storeName).index('cachedAt').openCursor(range)
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

export function clearOldTranslations(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  return deleteOlderThan(TRANSLATIONS_STORE, maxAgeMs)
}

/** Evict TTS / explain entries past their 30-day TTL. Reads already skip them;
 *  this frees the storage. Called once per app start (main.tsx). */
export async function clearExpiredCaches(): Promise<void> {
  const ttl = 30 * 24 * 60 * 60 * 1000
  await Promise.allSettled([TTS_STORE, EXPLAIN_STORE].map(s => deleteOlderThan(s, ttl)))
}

// ============ TTS AUDIO CACHE ============

function makeTtsKey(lang: string, text: string): string {
  return `${lang}:${hashText(text)}`
}

export async function getCachedTtsAudio(
  lang: string,
  text: string
): Promise<CachedTtsAudio | null> {
  const db = await openOfflineDb()
  const key = makeTtsKey(lang, text)

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TTS_STORE, 'readonly')
    const store = tx.objectStore(TTS_STORE)
    const request = store.get(key)

    request.onsuccess = () => {
      const result = request.result as CachedTtsAudio | undefined
      if (result && Date.now() - result.cachedAt < 30 * 24 * 60 * 60 * 1000) {
        resolve(result)
      } else {
        resolve(null)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

export async function cacheTtsAudio(
  lang: string,
  text: string,
  audioData: ArrayBuffer
): Promise<void> {
  const db = await openOfflineDb()
  const cached: CachedTtsAudio = {
    key: makeTtsKey(lang, text),
    audioData,
    lang,
    cachedAt: Date.now(),
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(TTS_STORE, 'readwrite')
    const store = tx.objectStore(TTS_STORE)
    const request = store.put(cached)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

// ============ PENDING VOCAB WORDS (anonymous accumulator) ============

export async function addPendingVocabWord(word: PendingVocabWord): Promise<void> {
  const db = await openOfflineDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_VOCAB_STORE, 'readwrite')
    const store = tx.objectStore(PENDING_VOCAB_STORE)
    const request = store.add(word)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function listPendingVocabWords(): Promise<PendingVocabWord[]> {
  const db = await openOfflineDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_VOCAB_STORE, 'readonly')
    const store = tx.objectStore(PENDING_VOCAB_STORE)
    const index = store.index('createdAt')
    const request = index.getAll()
    request.onsuccess = () => resolve(request.result as PendingVocabWord[])
    request.onerror = () => reject(request.error)
  })
}

export async function countPendingVocabWords(): Promise<number> {
  const db = await openOfflineDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_VOCAB_STORE, 'readonly')
    const store = tx.objectStore(PENDING_VOCAB_STORE)
    const request = store.count()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function deletePendingVocabWord(id: string): Promise<void> {
  const db = await openOfflineDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PENDING_VOCAB_STORE, 'readwrite')
    const store = tx.objectStore(PENDING_VOCAB_STORE)
    const request = store.delete(id)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

// ============ EXPLAIN CACHE ============

const EXPLAIN_TTL_MS = 30 * 24 * 60 * 60 * 1000

function makeExplainKey(word: string, sentence: string, genre: string | null | undefined, targetLang: string): string {
  return `${word.toLowerCase()}|${sentence}|${genre || ''}|${targetLang}`
}

export async function getCachedExplain(
  word: string,
  sentence: string,
  genre: string | null | undefined,
  targetLang: string
): Promise<CachedExplain | null> {
  const db = await openOfflineDb()
  const key = makeExplainKey(word, sentence, genre, targetLang)

  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPLAIN_STORE, 'readonly')
    const store = tx.objectStore(EXPLAIN_STORE)
    const request = store.get(key)

    request.onsuccess = () => {
      const result = request.result as CachedExplain | undefined
      if (result && Date.now() - result.cachedAt < EXPLAIN_TTL_MS) {
        resolve(result)
      } else {
        resolve(null)
      }
    }
    request.onerror = () => reject(request.error)
  })
}

export async function cacheExplain(
  word: string,
  sentence: string,
  genre: string | null | undefined,
  targetLang: string,
  explanation: string
): Promise<void> {
  const db = await openOfflineDb()
  const cached: CachedExplain = {
    key: makeExplainKey(word, sentence, genre, targetLang),
    explanation,
    word,
    targetLang,
    cachedAt: Date.now(),
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(EXPLAIN_STORE, 'readwrite')
    const store = tx.objectStore(EXPLAIN_STORE)
    const request = store.put(cached)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}
