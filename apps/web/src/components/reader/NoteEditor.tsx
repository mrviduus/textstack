import { useEffect, useRef, useState } from 'react'
import type { StoredHighlight } from '../../lib/offlineDb'

interface NoteEditorProps {
  highlight: StoredHighlight
  rect: DOMRect | null
  containerRef: React.RefObject<HTMLElement | null>
  onSave: (noteText: string | null) => void
  onDelete: () => void
  onClose: () => void
}

export function NoteEditor({
  highlight,
  rect,
  containerRef,
  onSave,
  onDelete,
  onClose,
}: NoteEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [noteText, setNoteText] = useState(highlight.noteText ?? '')
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!rect || !containerRef.current || !editorRef.current) {
      setPosition(null)
      return
    }

    const container = containerRef.current
    const containerRect = container.getBoundingClientRect()
    const editor = editorRef.current
    const editorRect = editor.getBoundingClientRect()

    // Position below the highlight
    let top = rect.bottom + 8
    let left = rect.left + rect.width / 2 - editorRect.width / 2

    // Clamp to container bounds
    const minLeft = containerRect.left + 8
    const maxLeft = containerRect.right - editorRect.width - 8
    left = Math.max(minLeft, Math.min(left, maxLeft))

    // If no room below, show above
    if (top + editorRect.height > window.innerHeight - 8) {
      top = rect.top - editorRect.height - 8
    }

    // Ensure visible in viewport
    top = Math.max(8, Math.min(top, window.innerHeight - editorRect.height - 8))

    setPosition({ top, left })
  }, [rect, containerRef, noteText])

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (editorRef.current && !editorRef.current.contains(e.target as Node)) {
        handleSave()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [noteText])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        handleSave()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [noteText])

  const handleSave = () => {
    const trimmed = noteText.trim()
    onSave(trimmed || null)
    onClose()
  }

  const handleDelete = () => {
    onDelete()
  }

  if (!rect) return null

  // Highlight color for the header
  const colorMap: Record<string, string> = {
    yellow: '#fef08a',
    green: '#bbf7d0',
    pink: '#fbcfe8',
    blue: '#bfdbfe',
  }

  return (
    <div
      ref={editorRef}
      className="note-editor"
      style={{
        position: 'fixed',
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <div
        className="note-editor__header"
        style={{ borderLeftColor: colorMap[highlight.color] || colorMap.yellow }}
      >
        <span className="note-editor__text-preview">
          {highlight.selectedText.length > 50
            ? highlight.selectedText.slice(0, 50) + '...'
            : highlight.selectedText}
        </span>
        <button
          className="note-editor__close"
          onClick={onClose}
          aria-label="Close"
        >
          x
        </button>
      </div>

      <textarea
        ref={textareaRef}
        className="note-editor__textarea"
        value={noteText}
        onChange={(e) => setNoteText(e.target.value)}
        placeholder="Add a note..."
        rows={4}
      />

      <div className="note-editor__footer">
        <button
          className="note-editor__delete"
          onClick={handleDelete}
          title="Delete highlight"
        >
          <TrashIcon />
        </button>
        <div className="note-editor__actions">
          <button className="note-editor__cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="note-editor__save" onClick={handleSave}>
            Save
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
