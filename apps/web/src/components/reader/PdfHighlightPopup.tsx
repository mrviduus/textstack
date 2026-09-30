import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import type { HighlightColor, StoredHighlight } from '../../lib/offlineDb'
import { useTranslation } from '../../hooks/useTranslation'
import { ReviewedRow } from './ReviewedMarks'

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
  highlight: StoredHighlight
  rect: DOMRect | null
  containerRef: React.RefObject<HTMLElement | null>
  onRecolor: (color: HighlightColor) => void
  onNoteSave: (noteText: string | null) => void
  onDelete: () => void
  onClose: () => void
}

export function PdfHighlightPopup({
  highlight,
  rect,
  containerRef,
  onRecolor,
  onNoteSave,
  onDelete,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const editorRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [noteText, setNoteText] = useState(highlight.noteText ?? '')
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

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
    const trimmed = noteText.trim()
    // Only PUT when the note actually changed. Recoloring then dismissing (or a
    // click-outside) must NOT fire a redundant note save — that churns the
    // highlight version and can flash the pre-recolor color back for a frame.
    if (trimmed !== (highlight.noteText ?? '')) onNoteSave(trimmed || null)
    onClose()
  }, [noteText, onNoteSave, onClose, highlight.noteText])

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
      <ReviewedRow highlightId={highlight.id} />
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
        onChange={(e) => setNoteText(e.target.value)}
        placeholder={t('reader.noteEditor.placeholder')}
        rows={3}
      />

      <div className="note-editor__footer">
        <button
          className="note-editor__delete"
          onClick={onDelete}
          title={t('reader.noteEditor.deleteHighlight')}
          aria-label={t('reader.noteEditor.deleteHighlight')}
        >
          <TrashIcon />
        </button>
        <div className="note-editor__actions">
          <button className="note-editor__cancel" onClick={onClose}>
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
