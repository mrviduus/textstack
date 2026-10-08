import { useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'expo-router'
import { WebView } from 'react-native-webview'
import { createBooksApi, readingProgressApi, parseScrollLocator, chapterIdForSlug, parseTextPosition, serializeTextPosition } from '@textstack/shared'
import type { Language, TextPosition } from '@textstack/shared'
import { getLocalProgress, markLocalProgressSynced, saveLocalProgress, type LocalProgress } from '../../lib/progressStorage'
import { serverProvablyNewer } from '../../lib/progressRestore'
import { autoAddToLibrary } from '../../lib/libraryAutoAdd'
import { getCachedChapter, cacheChapter } from '../../lib/offlineDb'
import { useReaderChapter } from '../../hooks/useReaderChapter'
import { useReaderBook } from '../../hooks/useReaderBook'
import { useReaderBookmarks, getSlugFromLocator } from '../../hooks/useReaderBookmarks'
import { useReaderPersistence } from '../../hooks/useReaderPersistence'
import type { NewerPosition, ProgressSnapshot, ReaderRuntime, SavedPosition } from './readerSource'

type ToastFn = (t: { message: string; variant: 'error' | 'success' | 'info' }) => void

type Params = {
  bookSlug: string
  chapterSlug: string
  language: Language
  isAuthenticated: boolean
  showToast: ToastFn
}

/**
 * Catalog (edition) data source for the unified `<Reader>`. Composes the
 * battle-tested catalog hooks (chapter / book / bookmarks)
 * and supplies the edition-specific progress I/O (`persist` / `loadPosition`)
 * to the shared `useReaderPersistence`. Returns the normalized `ReaderRuntime`.
 *
 * Offline-first: always writes local; authed users also PUT to the server.
 */
export function useEditionReaderSource({
  bookSlug,
  chapterSlug,
  language,
  isAuthenticated,
  showToast,
}: Params): ReaderRuntime {
  const router = useRouter()

  const webViewRef = useRef<WebView>(null)
  const injectJs = useCallback((js: string) => {
    webViewRef.current?.injectJavaScript(`try{${js}}catch(e){console.error('[diag] injectJs failed:', e && e.message, ${JSON.stringify(js.slice(0, 80))});};true;`)
  }, [])

  const progressRef = useRef(0)
  const scrollOffsetRef = useRef(0)
  const currentChapterSlugRef = useRef<string | null>(null)
  const bookProgressRef = useRef<number | null>(null)
  const positionRef = useRef<TextPosition | null>(null)
  const totalWordCountRef = useRef(0)
  const editionIdRef = useRef<string | null>(null)
  const bookTitleRef = useRef<string | null>(null)

  const { chapter, loading, chapterError, wordCountRef } = useReaderChapter({
    bookSlug, chapterSlug, language, editionIdRef,
  })

  const { bookmarks, setBookmarks, toggle, remove } = useReaderBookmarks({
    editionIdRef, isAuthenticated, showToast,
  })

  const { bookTitle, chapters, editionId, chaptersLoading } = useReaderBook({
    bookSlug, language, isAuthenticated, editionIdRef, bookTitleRef, totalWordCountRef, setBookmarks,
  })

  // Puts a chapter on the device before the reader opens it (end-of-chapter
  // block), so the open is instant and works offline. Device first — a cache
  // hit costs no network (chapterLoadOrder.test.ts). Throws when neither has it.
  // ponytail: for a book never downloaded these rows are listed nowhere (lists need the book's
  // meta row) and never swept — a few KB per chapter turn; sweep them if storage ever matters.
  const ensureChapter = useCallback(async (slug: string) => {
    const editionId = editionIdRef.current
    if (editionId && await getCachedChapter(editionId, slug)) return
    const ch = await createBooksApi(language).getChapter(bookSlug, slug)
    if (editionIdRef.current) await cacheChapter(editionIdRef.current, ch)
  }, [bookSlug, language])

  const isChapterOnDevice = useCallback(async (slug: string) => {
    const id = editionIdRef.current
    return !!id && !!(await getCachedChapter(id, slug))
  }, [])

  // The chapter list, in a ref so `persist` can read it without being rebuilt on every change —
  // it is handed to useReaderPersistence, which keys effects on its identity.
  const chaptersRef = useRef(chapters)
  chaptersRef.current = chapters
  // The chapter the URL names, for the same reason: `persist` has to be able to tell "the reader is
  // still where the route put them" from "the reader has scrolled somewhere else".
  const routeChapterSlugRef = useRef(chapterSlug)
  routeChapterSlugRef.current = chapterSlug

  const persist = useCallback((snap: ProgressSnapshot) => {
    const id = editionIdRef.current
    if (!id) return

    // The id for the slug being saved. The server has no slug column — it derives `chapterSlug`
    // by joining this id — so an id that disagrees with the locator makes resume open the wrong
    // chapter (#496). One chapter per document now, so the snapshot slug is the route slug and the
    // fallback is the route's own id; the list lookup stays as the authority when it has loaded.
    // `||`, not `??`: an offline table of contents built from the device carries '' for a row
    // cached before chapter ids were stored (useReaderBook, M2).
    const chapterId = chapterIdForSlug(chaptersRef.current, snap.chapterSlug)
      || (snap.chapterSlug === routeChapterSlugRef.current ? snap.chapterId : null)
    // Assigned, never carried forward — the same rule the server applies. An
    // anchor kept beside a fresher pixel offset is a record contradicting itself.
    const positionJson = serializeTextPosition(snap.position) ?? undefined
    saveLocalProgress(id, {
      // '' rather than null: getAllLocalProgress() validates this field as a
      // string and would drop the whole record otherwise. The local row is
      // keyed and resumed by slug; the id only matters to the server.
      chapterId: chapterId ?? '',
      chapterSlug: snap.chapterSlug,
      locator: `scroll:${snap.chapterSlug}:${snap.scrollOffset}`,
      positionJson,
      percent: snap.chapterPercent,
      // null leaves the prior bookPercent in place (resume card would
      // otherwise lose its hint between mount and chapters arriving).
      bookPercent: snap.bookPercent ?? undefined,
      updatedAt: snap.updatedAt,
    }).catch(() => {})

    if (!isAuthenticated) return
    // Web parity: in the library once 1% in — once per book per session. See libraryAutoAdd.ts.
    void autoAddToLibrary(id, snap.bookPercent)
    // The server row is keyed by chapter id. An offline-cached chapter has no
    // id to give, so there is nothing to send — the local write above is the
    // record, and useReaderPersistence repeats the save once an id appears.
    if (!chapterId) return
    // Book-wide, matching ReadingProgress.Percent's declared unit. A chapter
    // fraction is NEVER a substitute: it is 1.0 at the end of every chapter, so
    // it wrote "book finished" into the column. Unknown (chapter list not loaded
    // yet) → no server write; the chapters-arrived effect below repeats the save.
    // Same rule as buildUserBookProgressPayload.
    if (snap.bookPercent == null) return
    return readingProgressApi.updateProgress(id, {
      chapterId,
      chapterSlug: snap.chapterSlug,
      progress: snap.bookPercent,
      scrollOffset: snap.scrollOffset,
      positionJson,
      recordedAt: snap.updatedAt,
    })
      // Acknowledged (or refused as older than the stored row — either way the
      // server's row is now at least as new as this one).
      .then(() => markLocalProgressSynced(id, snap.updatedAt))
      .catch((e) => { console.warn('[progress] save failed', e) })
  }, [isAuthenticated])

  // The local record this chapter opened from — what a server answer has to be
  // newer than. Kept rather than re-read: the reader's own first save would
  // otherwise "beat" a server position that was newer when the book opened.
  const openedFromRef = useRef<LocalProgress | null>(null)

  /** Where to reopen this chapter — from the DEVICE only. The server is asked in
   *  the background (loadNewerPosition) and never on this path. */
  const loadPosition = useCallback(async (slug: string): Promise<SavedPosition> => {
    const id = editionIdRef.current
    let local: LocalProgress | null = null
    try { if (id) local = await getLocalProgress(id) } catch {}
    openedFromRef.current = local
    if (!local || local.chapterSlug !== slug) return { position: null, offset: null, percent: null }
    const p = parseTextPosition(local.positionJson)
    const parsed = parseScrollLocator(local.locator)
    // Only restore a mid-chapter percent (skip ~start/~end → leave at top).
    const percent = typeof local.percent === 'number' && local.percent > 0.005 && local.percent < 0.999 ? local.percent : null
    return {
      position: p && p.chapterSlug === slug ? p : null,
      offset: parsed && parsed.slug === slug && parsed.offset > 0 ? parsed.offset : null,
      percent,
    }
  }, [])

  /** Background, after the open: the server's position, when provably newer than
   *  the local record the chapter opened from (another device, or a new phone). */
  const loadNewerPosition = useCallback(async (slug: string, opts?: { latest?: boolean }): Promise<NewerPosition | null> => {
    const id = editionIdRef.current
    if (!isAuthenticated || !id) return null
    // Foreground return (H3): the record as it is at the return, so this device's own writes since
    // the open never look like another device's. Read before the request: a scroll made while it
    // is in flight must not hide the other device's position — that one gets the prompt.
    const base = opts?.latest ? await getLocalProgress(id) : openedFromRef.current
    const server = await readingProgressApi.getProgress(id)
    if (!serverProvablyNewer(base, server)) return null
    // Position comes from the LOCATOR, never from the percent: the stored percent
    // spans the whole book. The locator names its chapter; `chapterSlug` can lag (#496).
    const parsed = parseScrollLocator(server.locator)
    const target = parsed?.slug ?? server.chapterSlug
    if (!target) return null
    const p = parseTextPosition(server.positionJson)
    const saved: SavedPosition = {
      position: p && p.chapterSlug === target ? p : null,
      offset: parsed && parsed.slug === target && parsed.offset > 0 ? parsed.offset : null,
      percent: null,
    }
    if (target === slug && !saved.position && saved.offset == null) return null
    const label = chaptersRef.current.find(c => c.slug === target)?.title ?? target
    return { chapterSlug: target, saved, label }
  }, [isAuthenticated])

  const navigateToChapter = useCallback((slug: string) => {
    router.replace(`/reader/${bookSlug}/${slug}`)
  }, [router, bookSlug])

  const { saveProgress, bumpProgress, onWebViewLoaded, onRestoreLanded, onDocumentRebuild, reflow, chapterNavigatorRef, positionSettled, sessionJumpRef } = useReaderPersistence({
    bookKey: editionId,
    chapterSlug,
    chapterId: chapter?.id ?? null,
    injectJs,
    progressRef, scrollOffsetRef, currentChapterSlugRef, bookProgressRef, positionRef,
    persist, loadPosition, loadNewerPosition, navigateToChapter,
  })

  // The chapter list arriving is the second chance for a server write that had to be held back.
  // `useReaderPersistence` replays a deferred save when the chapter *id* lands, which is a
  // different signal — that one is about the route chapter's own fetch, and it has already
  // resolved by the time this matters. Fires once, on the transition from no list to a list.
  const chaptersArrivedRef = useRef(false)
  useEffect(() => {
    if (chaptersArrivedRef.current || chapters.length === 0) return
    chaptersArrivedRef.current = true
    saveProgress()
  }, [chapters, saveProgress])

  return {
    source: { kind: 'edition', id: editionId, idRef: editionIdRef, slug: bookSlug },
    webViewRef,
    injectJs,
    chapter: chapter
      ? { id: chapter.id, title: chapter.title, html: chapter.html, prev: chapter.prev, next: chapter.next }
      : null,
    loading,
    chapterError,
    chapterSlug,
    htmlChapterSlug: chapterSlug,
    bookTitle,
    bookTitleRef,
    chapters,
    chaptersLoading,
    wordCount: wordCountRef.current,
    progressRef, scrollOffsetRef, currentChapterSlugRef, bookProgressRef, positionRef, totalWordCountRef,
    saveProgress, bumpProgress, onWebViewLoaded, onRestoreLanded, onDocumentRebuild, reflow, positionSettled, sessionJumpRef,
    ensureChapter,
    isChapterOnDevice,
    onNavigateChapter: navigateToChapter,
    chapterNavigatorRef,
    bookmarks,
    onToggleCurrentBookmark: (slug) => { if (chapter) toggle({ chapter, slug }) },
    onDeleteBookmark: remove,
    bookmarkChapterSlug: (b) => getSlugFromLocator(b.locator),
    explainBookId: editionIdRef.current || undefined,
  }
}
