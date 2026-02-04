import { useEffect, useRef, useState } from 'react'
import type { DictionaryEntry } from '../../api/dictionary'

interface DictionaryPopupProps {
  word: string
  entry: DictionaryEntry | null
  isLoading: boolean
  error: string | null
  rect: DOMRect | null
  containerRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}

export function DictionaryPopup({
  word,
  entry,
  isLoading,
  error,
  rect,
  containerRef,
  onClose,
}: DictionaryPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!rect || !containerRef.current || !popupRef.current) {
      setPosition(null)
      return
    }

    const container = containerRef.current
    const containerRect = container.getBoundingClientRect()
    const popup = popupRef.current
    const popupRect = popup.getBoundingClientRect()

    // Position below selection
    let top = rect.bottom + 8
    let left = rect.left + rect.width / 2 - popupRect.width / 2

    // Clamp to container bounds
    const minLeft = containerRect.left + 8
    const maxLeft = containerRect.right - popupRect.width - 8
    left = Math.max(minLeft, Math.min(left, maxLeft))

    // If no room below, show above
    if (top + popupRect.height > window.innerHeight - 8) {
      top = rect.top - popupRect.height - 8
    }

    // Ensure visible in viewport
    top = Math.max(8, Math.min(top, window.innerHeight - popupRect.height - 8))

    setPosition({ top, left })
  }, [rect, containerRef, entry, isLoading, error])

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  if (!rect) return null

  return (
    <div
      ref={popupRef}
      className="dictionary-popup"
      style={{
        position: 'fixed',
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? 'visible' : 'hidden',
        touchAction: 'none',
      }}
    >
      <div className="dictionary-popup__header">
        <span className="dictionary-popup__word">{word}</span>
        {entry?.phonetic && (
          <span className="dictionary-popup__phonetic">{entry.phonetic}</span>
        )}
        <button
          className="dictionary-popup__close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="dictionary-popup__content">
        {isLoading && (
          <div className="dictionary-popup__loading">
            <span className="dictionary-popup__spinner" />
            Looking up...
          </div>
        )}

        {error && (
          <div className="dictionary-popup__error">{error}</div>
        )}

        {entry && !isLoading && !error && (
          <div className="dictionary-popup__definitions">
            {entry.definitions.map((meaning, idx) => (
              <div key={idx} className="dictionary-popup__meaning">
                <div className="dictionary-popup__pos">{meaning.partOfSpeech}</div>
                <ol className="dictionary-popup__def-list">
                  {meaning.definitions.map((def, defIdx) => (
                    <li key={defIdx} className="dictionary-popup__def-item">
                      <span className="dictionary-popup__def-text">
                        {def.definition}
                      </span>
                      {def.example && (
                        <span className="dictionary-popup__example">
                          "{def.example}"
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
