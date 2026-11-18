import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import type { HighlightColor, StoredHighlight } from '../../lib/offlineDb'
import { useTranslation } from '../../hooks/useTranslation'
import { noteChange } from '../../../../../packages/reader/src/highlights.mjs'

// Dedicated edit popup for an Original-layout PDF highlight (parity with reflow:
// recolor / delete / note). Deliberately NOT the reflow NoteEditor — that one is
// wired to text-offset anchors and the reflow highlight-edit hook; keeping this
// standalone avoids threading PDF concerns through the reflow path.

const COLORS: HighlightColor[] = ['yellow', 'green', 'pink', 'blue']

// Solid swatch fills (opaque) — the header/swatches want a clear color chip,
// not the translucent paint tint used on the page.
const SWATCH: Record<HighlightColor, string> = {
  yellow: '#fef08a',
  green: '#bbf7d0',
  pink: '#fbcfe8',
  blue: '#bfdbfe',
}

interface Props {
  /** What the popup shows and edits: the legacy PDF highlight, or a V2 one (#1312). */
  highlight: Pick<StoredHighlight, 'id' | 'color' | 'selectedText' | 'noteText'>
  rect: DOMRect | null
  containerRef: React.RefObject<HTMLElement | null>
  onRecolor: (color: HighlightColor) => void
  /** The legacy PDF reader's save; the V2 reader passes `onDraft` instead (the host writes). */
  onNoteSave?: (noteText: string | null) => void
  onDelete: () => void
  onClose: () => void
  /**
   * #1312 review (the V2 reader): the draft as it is typed, with the note the popup opened with, so the host can write a
   * changed one whatever closes the popup (a tap in the book, Escape, ×, leaving the route, closing the tab); Save and
   * Cancel (the note at opening) are drafts too, written by the host. Null: nothing left to write (Delete).
   */
  onDraft?: (draft: { text: string; from: string | null } | null) => void
}

export function PdfHighlightPopup({
  highlight,
  rect,
  containerRef,
  onRecolor,
  onNoteSave,
  onDelete,
  onClose,
  onDraft,
}: Props) {
  const { t } = useTranslation()
  const editorRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [noteText, setNoteText] = useState(highlight.noteText ?? '')
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  /** The note the popup opened with: every save compares the draft with it (`noteChange`), never with a later prop. */
  const from = useRef(highlight.noteText ?? null).current
  const edit = (text: string) => {
    setNoteText(text)
    onDraft?.({ text, from })
  }

  // Reposition before paint (mirrors NoteEditor) so there's no mount flash.
  useLayoutEffect(() => {
    if (!rect || !containerRef.current || !editorRef.current) {
      setPosition(null)
      return
    }
    const containerRect = containerRef.current.getBoundingClientRect()
    const editorRect = editorRef.current.getBoundingClientRect()

    let top = rect.bottom + 8
    let left = rect.left + rect.width / 2 - editorRect.width / 2

    const minLeft = containerRect.left + 8
    const maxLeft = containerRect.right - editorRect.width - 8
    left = Math.max(minLeft, Math.min(left, maxLeft))

    if (top + editorRect.height > window.innerHeight - 8) {
      top = rect.top - editorRect.height - 8
    }
    top = Math.max(8, Math.min(top, window.innerHeight - editorRect.height - 8))

    setPosition({ top, left })
  }, [rect, containerRef])

  const handleSaveNote = useCallback(() => {
    // Only PUT when the note actually changed (`noteChange`: trimmed, against the note at opening). Recoloring then
    // dismissing (or a click-outside) must NOT fire a redundant note save — that churns the highlight version and can
    // flash the pre-recolor color back for a frame.
    // The V2 reader's host owns the write (`onDraft`): it may have written a draft already (the tab hidden), so it
    // decides against what it last wrote.
    if (onDraft) {
      onDraft({ text: noteText, from })
      return onClose()
    }
    const note = noteChange(noteText, from)
    if (note !== undefined) onNoteSave?.(note)
    onClose()
  }, [noteText, onNoteSave, onClose, onDraft, from])
  /** Cancel: back to the note at opening (the host writes it only if it wrote something else meanwhile). */
  const cancel = () => {
    onDraft?.({ text: from ?? '', from })
    onClose()
  }
  /** Delete: nothing of the draft is written. */
  const discard = (then: () => void) => () => {
    onDraft?.(null)
    then()
  }

  // Close (persisting the note) on click-outside.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (editorRef.current && !editorRef.current.contains(e.target as Node)) {
        handleSaveNote()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [handleSaveNote])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveNote()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleSaveNote, onClose])

  if (!rect) return null

  return (
    <div
      ref={editorRef}
      className="note-editor pdf-hl-popup"
      style={{
        position: 'fixed',
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? 'visible' : 'hidden',
        touchAction: 'none',
      }}
    >
      <div className="note-editor__header" style={{ borderLeftColor: SWATCH[highlight.color] }}>
        <span className="note-editor__text-preview">
          {highlight.selectedText.length > 50
            ? highlight.selectedText.slice(0, 50) + '...'
            : highlight.selectedText}
        </span>
        <button
          className="note-editor__close"
          onClick={onClose}
          aria-label={t('reader.noteEditor.close')}
        >
          ×
        </button>
      </div>

      <div className="pdf-hl-popup__swatches" role="group" aria-label={t('reader.highlight.colors')}>
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`pdf-hl-popup__swatch${highlight.color === c ? ' pdf-hl-popup__swatch--active' : ''}`}
            style={{ background: SWATCH[c] }}
            aria-label={c}
            aria-pressed={highlight.color === c}
            onClick={() => onRecolor(c)}
          />
        ))}
      </div>

      <textarea
        ref={textareaRef}
        className="note-editor__textarea"
        value={noteText}
        onChange={(e) => edit(e.target.value)}
        placeholder={t('reader.noteEditor.placeholder')}
        rows={3}
      />

      <div className="note-editor__footer">
        <button
          className="note-editor__delete"
          onClick={discard(onDelete)}
          title={t('reader.noteEditor.deleteHighlight')}
          aria-label={t('reader.noteEditor.deleteHighlight')}
        >
          <TrashIcon />
        </button>
        <div className="note-editor__actions">
          <button className="note-editor__cancel" onClick={cancel}>
            {t('reader.noteEditor.cancel')}
          </button>
          <button className="note-editor__save" onClick={handleSaveNote}>
            {t('reader.noteEditor.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
      <path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  )
}
