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

// CSS styles - add to reader.css
export const dictionaryPopupStyles = `
.dictionary-popup {
  width: 340px;
  max-width: 90vw;
  max-height: 400px;
  background: var(--reader-bg);
  border: 1px solid var(--reader-border);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  z-index: 160;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.dictionary-popup__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--reader-border);
  border-bottom: 1px solid var(--reader-border);
}

.dictionary-popup__word {
  font-weight: 600;
  font-size: 16px;
  color: var(--reader-text);
}

.dictionary-popup__phonetic {
  color: var(--reader-secondary);
  font-size: 13px;
  font-style: italic;
}

.dictionary-popup__close {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--reader-secondary);
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.dictionary-popup__close:hover {
  color: var(--reader-text);
}

.dictionary-popup__content {
  padding: 12px;
  overflow-y: auto;
  flex: 1;
}

.dictionary-popup__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--reader-secondary);
  font-size: 13px;
}

.dictionary-popup__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--reader-border);
  border-top-color: var(--reader-text);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.dictionary-popup__error {
  color: #e53935;
  font-size: 13px;
}

.dictionary-popup__definitions {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dictionary-popup__meaning {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dictionary-popup__pos {
  font-size: 12px;
  font-weight: 600;
  color: var(--reader-link);
  text-transform: capitalize;
}

.dictionary-popup__def-list {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dictionary-popup__def-item {
  font-size: 14px;
  line-height: 1.5;
  color: var(--reader-text);
}

.dictionary-popup__def-text {
  display: block;
}

.dictionary-popup__example {
  display: block;
  margin-top: 4px;
  font-size: 13px;
  font-style: italic;
  color: var(--reader-secondary);
}
`
