import { useEffect, useRef, useState } from 'react'
import type { HighlightColor } from '../../lib/offlineDb'

const HIGHLIGHT_COLORS: { color: HighlightColor; label: string; hex: string }[] = [
  { color: 'yellow', label: 'Yellow', hex: '#fef08a' },
  { color: 'green', label: 'Green', hex: '#bbf7d0' },
  { color: 'pink', label: 'Pink', hex: '#fbcfe8' },
  { color: 'blue', label: 'Blue', hex: '#bfdbfe' },
]

interface SelectionToolbarProps {
  rect: DOMRect | null
  text: string
  containerRef: React.RefObject<HTMLElement | null>
  onHighlight: (color: HighlightColor) => void
  onTranslate?: () => void
  onDictionary?: () => void
  onCopy?: () => void
}

export function SelectionToolbar({
  rect,
  text,
  containerRef,
  onHighlight,
  onTranslate,
  onDictionary,
  onCopy,
}: SelectionToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!rect || !containerRef.current || !toolbarRef.current) {
      setPosition(null)
      return
    }

    const container = containerRef.current
    const containerRect = container.getBoundingClientRect()
    const toolbar = toolbarRef.current
    const toolbarRect = toolbar.getBoundingClientRect()

    // Position above selection
    let top = rect.top - toolbarRect.height - 8
    let left = rect.left + rect.width / 2 - toolbarRect.width / 2

    // Clamp to container bounds
    const minLeft = containerRect.left + 8
    const maxLeft = containerRect.right - toolbarRect.width - 8
    left = Math.max(minLeft, Math.min(left, maxLeft))

    // If no room above, show below
    if (top < containerRect.top + 8) {
      top = rect.bottom + 8
    }

    // Ensure visible in viewport
    top = Math.max(8, Math.min(top, window.innerHeight - toolbarRect.height - 8))

    setPosition({ top, left })
  }, [rect, containerRef])

  if (!rect || !text) {
    return null
  }

  // Check if selection is a single word (no spaces, reasonable length)
  const isSingleWord = text.trim().length > 0 &&
    text.trim().length <= 50 &&
    !/\s/.test(text.trim())

  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    onCopy?.()
  }

  return (
    <div
      ref={toolbarRef}
      className="selection-toolbar"
      style={{
        position: 'fixed',
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <div className="selection-toolbar__colors">
        {HIGHLIGHT_COLORS.map(({ color, label, hex }) => (
          <button
            key={color}
            className="selection-toolbar__color"
            style={{ background: hex }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onHighlight(color)}
            title={`Highlight ${label}`}
            aria-label={`Highlight ${label}`}
          />
        ))}
      </div>
      <div className="selection-toolbar__divider" />
      {onTranslate && (
        <button
          className="selection-toolbar__action"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onTranslate}
          title="Translate"
          aria-label="Translate selected text"
        >
          <TranslateIcon />
        </button>
      )}
      {onDictionary && isSingleWord && (
        <button
          className="selection-toolbar__action"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onDictionary}
          title="Dictionary"
          aria-label="Look up word in dictionary"
        >
          <DictionaryIcon />
        </button>
      )}
      <button
        className="selection-toolbar__action"
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleCopy}
        title="Copy"
        aria-label="Copy selected text"
      >
        <CopyIcon />
      </button>
    </div>
  )
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  )
}

function TranslateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 8l6 6" />
      <path d="M4 14l6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2v3" />
      <path d="M22 22l-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  )
}

function DictionaryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      <path d="M8 7h8" />
      <path d="M8 11h6" />
    </svg>
  )
}

// CSS styles - add to reader.css
export const selectionToolbarStyles = `
.selection-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--reader-bg);
  border: 1px solid var(--reader-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  z-index: 150;
}

.selection-toolbar__colors {
  display: flex;
  gap: 4px;
}

.selection-toolbar__color {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: transform 0.15s, border-color 0.15s;
}

.selection-toolbar__color:hover {
  transform: scale(1.15);
  border-color: var(--reader-text);
}

.selection-toolbar__divider {
  width: 1px;
  height: 20px;
  background: var(--reader-border);
  margin: 0 4px;
}

.selection-toolbar__action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  background: none;
  border: none;
  color: var(--reader-text);
  cursor: pointer;
  transition: background 0.15s;
}

.selection-toolbar__action:hover {
  background: var(--reader-border);
}
`
