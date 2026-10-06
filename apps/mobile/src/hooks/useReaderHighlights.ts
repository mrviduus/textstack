import { useCallback, useEffect, useRef, useState, MutableRefObject } from 'react'
import { highlightsApi, isPdfAnchor } from '@textstack/shared'
import type { PublicHighlight, PdfAnchor } from '@textstack/shared'
import { highlightCache, userBookHighlightCache } from '../lib/readerOfflineCache'
import { matchesChapter } from '../lib/highlightChapter'

type Selection = { text: string; anchor?: unknown } | null
type ToastFn = (t: { message: string; variant: 'error' | 'success' | 'info' }) => void
type User = { id: string } | null | undefined

/** Lightweight chapter shape — both Chapter and UserChapter satisfy it.
 *  We only need the id for highlight payload + chapter-match filtering. */
type ChapterLike = { id: string }

type Options = {
  /** Edition mode — pass editionId + editionIdRef. */
  editionId?: string | null
  editionIdRef?: MutableRefObject<string | null>
  /** User-book mode — pass userBookId + userBookIdRef. Mutually exclusive with editionId. */
  userBookId?: string | null
  userBookIdRef?: MutableRefObject<string | null>
  user: User
  isAuthenticated: boolean
  /** Either edition chapterId OR userChapterId — used for cache filtering. */
  chapterId: string | null | undefined
  injectJs: (js: string) => void
  showToast: ToastFn
  /** Original-layout PDF reader. Highlights are chapterless quad-rect (PDF)
   *  anchors painted by the bundled pdf.js viewer via `window.__setPdfHighlights`
   *  — NOT the reflow renderHighlight/<mark> path. Load is book-wide (no
   *  per-chapter filter) and filtered to PDF anchors. */
  original?: boolean
}

/** Cache facade — both stores have identical (get, set) shape. */
function pickCache(userBookMode: boolean) {
  return userBookMode ? userBookHighlightCache : highlightCache
}

/**
 * One hook covers both edition and user-book reader. Mode is implicit:
 *   - `editionId` set     → loads /me/highlights/{editionId}, creates with editionId+chapterId
 *   - `userBookId` set    → loads /me/highlights/userbook/{userBookId}, creates with userBookId+userChapterId
 *
 * Cache, load + paint, optimistic create/remove, reactive re-paint, color
 * change, note save — all shared.
 */
export function useReaderHighlights({
  editionId,
  editionIdRef,
  userBookId,
  userBookIdRef,
  user,
  isAuthenticated,
  chapterId,
  injectJs,
  showToast,
  original,
}: Options) {
  const userBookMode = !!userBookId
  // Stable "current book id" — `editionId` for edition mode, `userBookId`
  // for user-book mode. Drives cache key + load API choice.
  const bookId = userBookMode ? userBookId : editionId
  const cache = pickCache(userBookMode)

  const [editingHighlight, setEditingHighlight] = useState<PublicHighlight | null>(null)
  const highlightsRef = useRef<PublicHighlight[]>([])
  // Bump on every ref mutation (create/remove). A useEffect below re-injects
  // the full set of renderHighlight calls so the WebView mirrors highlightsRef
  // even if an inline injectJs missed (e.g. WebView still loading at the time).
  const [highlightsVersion, setHighlightsVersion] = useState(0)
  const bumpHighlights = useCallback(() => setHighlightsVersion(v => v + 1), [])

  // Original mode: push the current PDF highlights to the bundled pdf.js viewer.
  // It stores them and paints per-page over the text layer (fire-and-forget;
  // guarded so a not-yet-ready viewer just no-ops until the next push). Reflow
  // uses renderHighlight injections instead — the two paths never mix.
  const pushPdf = useCallback(() => {
    const list = highlightsRef.current
      .map(h => {
        let anchor: unknown
        try { anchor = JSON.parse(h.anchorJson) } catch { return null }
        if (!isPdfAnchor(anchor)) return null
        return { id: h.id, color: h.color, anchor: anchor as PdfAnchor }
      })
      .filter((x): x is { id: string; color: string; anchor: PdfAnchor } => x !== null)
    injectJs(`window.__setPdfHighlights && window.__setPdfHighlights(${JSON.stringify(list)})`)
  }, [injectJs])

  const skipFirstHighlightsRef = useRef(true)
  useEffect(() => {
    if (skipFirstHighlightsRef.current) {
      skipFirstHighlightsRef.current = false
      return
    }
    const t = setTimeout(() => {
      if (original) { pushPdf(); return }
      for (const h of highlightsRef.current) {
        if (chapterId && !matchesChapter(h, chapterId)) continue
        injectJs(`renderHighlight(${JSON.stringify(h.id)}, ${JSON.stringify(h.anchorJson)}, ${JSON.stringify(h.color)}, ${JSON.stringify(h.selectedText)})`)
      }
    }, 120)
    return () => clearTimeout(t)
  }, [highlightsVersion, chapterId, injectJs, original, pushPdf])

  // Load + paint existing highlights. Cache-first paint for offline survival;
  // API refresh overwrites. Cache keyed per-user so device-shared sign-ins
  // can't leak another account's highlights.
  //
  // Reflow: filter to the current chapter, renderHighlight per highlight.
  // Original PDF: book-wide (no chapter gate), filter to PDF anchors, push the
  // set to the pdf.js viewer to paint over the text layer.
  useEffect(() => {
    if (!isAuthenticated || !bookId) return
    if (!original && !chapterId) return
    let cancelled = false

    const paint = (list: PublicHighlight[]) => {
      if (original) {
        highlightsRef.current = list.filter(h => {
          try { return isPdfAnchor(JSON.parse(h.anchorJson)) } catch { return false }
        })
        pushPdf()
        return
      }
      const chapterHighlights = list.filter(h => matchesChapter(h, chapterId!))
      highlightsRef.current = chapterHighlights
      for (const h of chapterHighlights) {
        injectJs(`renderHighlight(${JSON.stringify(h.id)}, ${JSON.stringify(h.anchorJson)}, ${JSON.stringify(h.color)}, ${JSON.stringify(h.selectedText)})`)
      }
    }

    const uid = user?.id
    if (uid) {
      cache.get(uid, bookId).then(cached => {
        if (!cancelled && cached) paint(cached)
      })
    }

    const loader = userBookMode
      ? highlightsApi.getUserBookHighlights(bookId)
      : highlightsApi.getHighlights(bookId)
    loader
      .then(highlights => {
        if (cancelled) return
        paint(highlights)
        if (uid) cache.set(uid, bookId, highlights)
      })
      .catch(() => { /* offline — cache paint already rendered */ })
    return () => { cancelled = true }
  }, [isAuthenticated, chapterId, user?.id, bookId, userBookMode, cache, injectJs, original, pushPdf])

  /** Sync handle for callbacks — picks the right ref based on mode. */
  const currentBookId = useCallback((): string | null => {
    if (userBookMode) return userBookIdRef?.current ?? null
    return editionIdRef?.current ?? null
  }, [userBookMode, userBookIdRef, editionIdRef])

  const create = useCallback(
    async ({ color, selection, chapter }: { color: string; selection: NonNullable<Selection>; chapter: ChapterLike }) => {
      const bId = currentBookId()
      if (!bId) return
      try {
        const anchorJson = selection.anchor ? JSON.stringify(selection.anchor) : JSON.stringify({ exact: selection.text })
        const payload = userBookMode
          ? { userBookId: bId, userChapterId: chapter.id, anchorJson, color, selectedText: selection.text }
          : { editionId: bId, chapterId: chapter.id, anchorJson, color, selectedText: selection.text }
        const hl = await highlightsApi.createHighlight(payload)
        injectJs(`renderHighlight(${JSON.stringify(hl.id)}, ${JSON.stringify(anchorJson)}, ${JSON.stringify(color)}, ${JSON.stringify(selection.text)})`)
        highlightsRef.current = [...highlightsRef.current, hl]
        bumpHighlights()
        const uid = user?.id
        if (uid) {
          cache.get(uid, bId).then(prev => {
            cache.set(uid, bId, [...(prev || []), hl])
          })
        }
      } catch (e) {
        console.warn('Failed to create highlight:', e)
        showToast({ message: 'Could not add highlight. Try again.', variant: 'error' })
      }
    },
    [currentBookId, userBookMode, cache, injectJs, showToast, user?.id, bumpHighlights]
  )

  // Original PDF: create a CHAPTERLESS highlight from a quad-rect anchor (the
  // pdf.js viewer resolved it from the live selection; color is picked in the
  // RN toolbar). Persists under the userbook with no userChapterId (backend
  // S-a accepts it), then re-pushes the set so the new highlight paints.
  const createPdf = useCallback(
    async ({ color, anchor, selectedText }: { color: string; anchor: PdfAnchor; selectedText: string }) => {
      const bId = currentBookId()
      if (!bId) return
      try {
        const anchorJson = JSON.stringify(anchor)
        const hl = await highlightsApi.createHighlight({ userBookId: bId, anchorJson, color, selectedText })
        highlightsRef.current = [...highlightsRef.current, hl]
        pushPdf()
        bumpHighlights()
        const uid = user?.id
        if (uid) {
          cache.get(uid, bId).then(prev => {
            cache.set(uid, bId, [...(prev || []), hl])
          })
        }
      } catch (e) {
        console.warn('Failed to create PDF highlight:', e)
        showToast({ message: 'Could not add highlight. Try again.', variant: 'error' })
      }
    },
    [currentBookId, cache, pushPdf, showToast, user?.id, bumpHighlights]
  )

  const saveNote = useCallback(
    async (id: string, note: string) => {
      try {
        const updated = await highlightsApi.updateHighlight(id, { noteText: note || null })
        highlightsRef.current = highlightsRef.current.map(h => h.id === id ? updated : h)
        const uid = user?.id
        const bId = currentBookId()
        if (uid && bId) {
          cache.get(uid, bId).then(prev => {
            if (!prev) return
            cache.set(uid, bId, prev.map(h => h.id === id ? updated : h))
          })
        }
      } catch (e) {
        console.warn('Highlight note save failed:', e)
        showToast({ message: 'Could not save note. Try again.', variant: 'error' })
      }
    },
    [currentBookId, cache, showToast, user?.id]
  )

  const updateColor = useCallback(
    async (id: string, color: string) => {
      // Optimistic — paint the new color in the WebView, push to server,
      // roll back the cache state on failure.
      const prevHl = highlightsRef.current.find(h => h.id === id)
      if (!prevHl) return
      // Optimistic recolor. PDF: mutate the ref + re-push the set. Reflow: swap
      // the <mark> via renderHighlight injections.
      if (original) {
        highlightsRef.current = highlightsRef.current.map(h => h.id === id ? { ...h, color } : h)
        pushPdf()
      } else {
        injectJs(`removeHighlight(${JSON.stringify(id)})`)
        injectJs(`renderHighlight(${JSON.stringify(id)}, ${JSON.stringify(prevHl.anchorJson)}, ${JSON.stringify(color)}, ${JSON.stringify(prevHl.selectedText)})`)
      }
      try {
        const updated = await highlightsApi.updateHighlight(id, { color })
        highlightsRef.current = highlightsRef.current.map(h => h.id === id ? updated : h)
        if (original) pushPdf()
        bumpHighlights()
        const uid = user?.id
        const bId = currentBookId()
        if (uid && bId) {
          cache.get(uid, bId).then(prev => {
            if (!prev) return
            cache.set(uid, bId, prev.map(h => h.id === id ? updated : h))
          })
        }
      } catch (e) {
        console.warn('Highlight color update failed:', e)
        // Rollback paint
        if (original) {
          highlightsRef.current = highlightsRef.current.map(h => h.id === id ? prevHl : h)
          pushPdf()
        } else {
          injectJs(`removeHighlight(${JSON.stringify(id)})`)
          injectJs(`renderHighlight(${JSON.stringify(id)}, ${JSON.stringify(prevHl.anchorJson)}, ${JSON.stringify(prevHl.color)}, ${JSON.stringify(prevHl.selectedText)})`)
        }
        showToast({ message: 'Could not change color. Try again.', variant: 'error' })
      }
    },
    [currentBookId, cache, injectJs, showToast, user?.id, bumpHighlights, original, pushPdf]
  )

  const remove = useCallback(
    async (id: string) => {
      try {
        await highlightsApi.deleteHighlight(id)
        highlightsRef.current = highlightsRef.current.filter(h => h.id !== id)
        if (original) pushPdf()
        else injectJs(`removeHighlight(${JSON.stringify(id)})`)
        bumpHighlights()
        const uid = user?.id
        const bId = currentBookId()
        if (uid && bId) {
          cache.get(uid, bId).then(prev => {
            if (!prev) return
            cache.set(uid, bId, prev.filter(h => h.id !== id))
          })
        }
      } catch (e) {
        console.warn('Highlight delete failed:', e)
        showToast({ message: 'Could not delete highlight. Try again.', variant: 'error' })
      }
    },
    [currentBookId, cache, injectJs, showToast, user?.id, bumpHighlights, original, pushPdf]
  )

  return {
    highlightsRef,
    editingHighlight,
    setEditingHighlight,
    create,
    createPdf,
    /** Re-push the current PDF highlight set to the viewer (original mode).
     *  Called on pdfReady / WebView reload so highlights loaded before the
     *  viewer was ready get painted. No-op-ish in reflow (nothing consumes it). */
    repaintPdf: pushPdf,
    saveNote,
    updateColor,
    remove,
  }
}
