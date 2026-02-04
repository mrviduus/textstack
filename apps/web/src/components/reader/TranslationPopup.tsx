import { useEffect, useRef, useState } from 'react'
import type { LanguageInfo } from '../../api/translation'

interface TranslationPopupProps {
  text: string
  translatedText: string | null
  isLoading: boolean
  error: string | null
  sourceLang: string
  targetLang: string
  languages: LanguageInfo[]
  rect: DOMRect | null
  containerRef: React.RefObject<HTMLElement | null>
  onSourceLangChange: (lang: string) => void
  onTargetLangChange: (lang: string) => void
  onClose: () => void
}

export function TranslationPopup({
  text,
  translatedText,
  isLoading,
  error,
  sourceLang,
  targetLang,
  languages,
  rect,
  containerRef,
  onSourceLangChange,
  onTargetLangChange,
  onClose,
}: TranslationPopupProps) {
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
  }, [rect, containerRef, translatedText, isLoading, error])

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

  const truncatedText = text.length > 100 ? text.slice(0, 100) + '...' : text

  return (
    <div
      ref={popupRef}
      className="translation-popup"
      style={{
        position: 'fixed',
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <div className="translation-popup__header">
        <select
          className="translation-popup__lang-select"
          value={sourceLang}
          onChange={(e) => onSourceLangChange(e.target.value)}
        >
          {languages.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.name}
            </option>
          ))}
        </select>
        <span className="translation-popup__arrow">→</span>
        <select
          className="translation-popup__lang-select"
          value={targetLang}
          onChange={(e) => onTargetLangChange(e.target.value)}
        >
          {languages.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.name}
            </option>
          ))}
        </select>
        <button
          className="translation-popup__close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="translation-popup__source">
        {truncatedText}
      </div>

      <div className="translation-popup__divider" />

      <div className="translation-popup__result">
        {isLoading && (
          <div className="translation-popup__loading">
            <span className="translation-popup__spinner" />
            Translating...
          </div>
        )}
        {error && (
          <div className="translation-popup__error">
            {error}
          </div>
        )}
        {translatedText && !isLoading && !error && (
          <div className="translation-popup__translated">
            {translatedText}
          </div>
        )}
      </div>
    </div>
  )
}

// CSS styles - add to reader.css
export const translationPopupStyles = `
.translation-popup {
  width: 320px;
  max-width: 90vw;
  background: var(--reader-bg);
  border: 1px solid var(--reader-border);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  z-index: 160;
  overflow: hidden;
}

.translation-popup__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--reader-border);
  border-bottom: 1px solid var(--reader-border);
}

.translation-popup__lang-select {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid var(--reader-border);
  border-radius: 4px;
  background: var(--reader-bg);
  color: var(--reader-text);
  font-size: 12px;
  cursor: pointer;
}

.translation-popup__arrow {
  color: var(--reader-secondary);
  font-size: 14px;
}

.translation-popup__close {
  background: none;
  border: none;
  color: var(--reader-secondary);
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.translation-popup__close:hover {
  color: var(--reader-text);
}

.translation-popup__source {
  padding: 12px;
  font-size: 13px;
  color: var(--reader-secondary);
  line-height: 1.5;
}

.translation-popup__divider {
  height: 1px;
  background: var(--reader-border);
  margin: 0 12px;
}

.translation-popup__result {
  padding: 12px;
  min-height: 40px;
}

.translation-popup__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--reader-secondary);
  font-size: 13px;
}

.translation-popup__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--reader-border);
  border-top-color: var(--reader-text);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.translation-popup__error {
  color: #e53935;
  font-size: 13px;
}

.translation-popup__translated {
  font-size: 14px;
  line-height: 1.5;
  color: var(--reader-text);
}
`
