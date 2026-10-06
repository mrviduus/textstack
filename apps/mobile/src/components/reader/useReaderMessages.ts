import { useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { useHaptics } from '../../hooks/useHaptics'
import type { useReaderWordActions } from './useReaderWordActions'

type WordActions = ReturnType<typeof useReaderWordActions>

interface Args {
  original?: boolean
  toggleBars: () => void
  showBars: () => void
  hideBars: () => void
  recordSessionActivity: () => void
  haptics: ReturnType<typeof useHaptics>
  /** useReaderSessionFeed — 'progress' / 'restored'. True when handled. */
  onPositionMessage: (data: any) => boolean
  /** useReaderPdf — the viewer's `pdf*` messages. True when handled. */
  onPdfMessage: (data: any) => boolean
  onChapterEndActionRef: MutableRefObject<(action: string) => void>
  highlightsRef: WordActions['highlightsRef']
  setEditingHighlight: WordActions['setEditingHighlight']
  openSelection: WordActions['openSelection']
  createPdfHighlight: WordActions['createPdfHighlight']
  pendingPdfColorRef: MutableRefObject<string>
}

/** The WebView's `onMessage`: parses the bridge message and routes it to whoever owns it. */
export function useReaderMessages({
  original, toggleBars, showBars, hideBars, recordSessionActivity, haptics,
  onPositionMessage, onPdfMessage, onChapterEndActionRef,
  highlightsRef, setEditingHighlight, openSelection, createPdfHighlight, pendingPdfColorRef,
}: Args) {
  return useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data)
      if (data.type === 'log') {
        if (__DEV__) {
          const fn = data.level === 'error' ? console.error : data.level === 'warn' ? console.warn : console.log
          fn('[WV]', data.msg)
        }
        return
      }
      // Position reports and the PDF viewer's messages are routed to the hooks that own them.
      if (onPositionMessage(data) || onPdfMessage(data)) return
      if (data.type === 'tap') {
        toggleBars()
      } else if (data.type === 'scrollDir') {
        // Original PDF has no word-based 'progress' message, so genuine scroll
        // is the session's activity signal (time-only — never a page percent).
        if (original) recordSessionActivity()
        if (data.dir === 'up') showBars()
        else if (data.dir === 'down') hideBars()
      } else if (data.type === 'chapterEnd') {
        onChapterEndActionRef.current(data.action)
      } else if (data.type === 'highlightTap') {
        const hl = highlightsRef.current.find(h => h.id === data.highlightId)
        if (hl) setEditingHighlight(hl)
      } else if (data.type === 'wordEngage') {
        // Word resolved via deliberate long-press (Item A). Light selection
        // impact confirms the hold registered before the WordCard opens.
        haptics.play('flip')
      } else if (data.type === 'selection') {
        // No speech here. A single-word selection used to auto-speak, but the
        // message carrying it arrives from the 450ms long-press — which is also
        // the first frame of a drag that is on its way to selecting a sentence.
        // The word started playing under a gesture that had not finished saying
        // what it wanted, and then owned the player the toolbar's Listen button
        // needed. Speech is now only ever started by pressing a button.
        const mode: 'tap' | 'drag' = data.mode === 'tap' ? 'tap' : 'drag'
        openSelection(data.text ? { ...data, mode } : null)
      } else if (data.type === 'pdfHighlightCreate') {
        // Original PDF: the viewer resolved a quad-rect anchor for the current
        // selection. Persist it (chapterless userbook highlight) with the color
        // the user picked in the toolbar; the hook re-pushes the set to repaint.
        const anchor = data.anchor
        if (anchor && Array.isArray(anchor.rects) && anchor.rects.length > 0) {
          void createPdfHighlight({ color: pendingPdfColorRef.current, anchor, selectedText: anchor.exact || '' })
        }
      }
    } catch (err) {
      if (__DEV__) console.warn('[reader] postMessage handler threw', err, event?.nativeEvent?.data)
    }
  }, [toggleBars, showBars, hideBars, setEditingHighlight, openSelection, haptics,
      original, recordSessionActivity, createPdfHighlight, onPositionMessage, onPdfMessage])
}
