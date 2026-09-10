import { useLayoutEffect, useRef, useState } from 'react'
import type { HighlightColor } from '../../lib/offlineDb'
import { useTranslation } from '../../hooks/useTranslation'

const HIGHLIGHT_COLORS: { color: HighlightColor; labelKey: string; hex: string }[] = [
  { color: 'yellow', labelKey: 'reader.selectionToolbar.highlightYellow', hex: '#fef08a' },
  { color: 'green', labelKey: 'reader.selectionToolbar.highlightGreen', hex: '#bbf7d0' },
  { color: 'pink', labelKey: 'reader.selectionToolbar.highlightPink', hex: '#fbcfe8' },
  { color: 'blue', labelKey: 'reader.selectionToolbar.highlightBlue', hex: '#bfdbfe' },
]

interface SelectionToolbarProps {
  rect: DOMRect | null
  text: string
  containerRef: React.RefObject<HTMLElement | null>
  /** Original-layout PDF mode: highlights are reflow-only, so hide the color swatches. */
  hideHighlight?: boolean
  onHighlight: (color: HighlightColor) => void
  onTranslate?: () => void
  onExplain?: () => void
  onAskAbout?: () => void
  onSpeak?: () => void
  onCopy?: () => void
}

export function SelectionToolbar({
  rect,
  text,
  containerRef,
  hideHighlight = false,
  onHighlight,
  onTranslate,
  onExplain,
  onAskAbout,
  onSpeak,
  onCopy,
}: SelectionToolbarProps) {
  const { t } = useTranslation()
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  // useLayoutEffect: reposition before paint, no flash when toolbar mounts or
  // when re-measuring after the toolbar DOM first renders (it needs its own
  // rect to compute position).
  useLayoutEffect(() => {
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
      {!hideHighlight && (
        <>
          <div className="selection-toolbar__colors">
            {HIGHLIGHT_COLORS.map(({ color, labelKey, hex }) => {
              const label = t(labelKey)
              return (
                <button
                  key={color}
                  className="selection-toolbar__color"
                  style={{ background: hex }}
                  onMouseDown={(e) => e.preventDefault()}
                  onTouchStart={(e) => e.preventDefault()}
                  onClick={() => onHighlight(color)}
                  title={label}
                  aria-label={label}
                />
              )
            })}
          </div>
          <div className="selection-toolbar__divider" />
        </>
      )}
      {onTranslate && (
        <button
          className="selection-toolbar__action"
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={(e) => e.preventDefault()}
          onClick={onTranslate}
          title={t('reader.selectionToolbar.translate')}
          aria-label={t('reader.selectionToolbar.translate')}
        >
          <TranslateIcon />
        </button>
      )}
      {onExplain && (
        <button
          className="selection-toolbar__action"
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={(e) => e.preventDefault()}
          onClick={onExplain}
          title={t('reader.selectionToolbar.explain')}
          aria-label={t('reader.selectionToolbar.explain')}
        >
          <ExplainIcon />
        </button>
      )}
      {onAskAbout && (
        <button
          className="selection-toolbar__action"
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={(e) => e.preventDefault()}
          onClick={onAskAbout}
          title={t('reader.selectionToolbar.askAboutThis')}
          aria-label={t('reader.selectionToolbar.askAboutThis')}
        >
          <AskAboutIcon />
        </button>
      )}
      {onSpeak && text.trim().length <= 500 && (
        <button
          className="selection-toolbar__action"
          onMouseDown={(e) => e.preventDefault()}
          onTouchStart={(e) => e.preventDefault()}
          onClick={onSpeak}
          title={t('reader.selectionToolbar.listen')}
          aria-label={t('reader.selectionToolbar.listen')}
        >
          <SpeakIcon />
        </button>
      )}
      <button
        className="selection-toolbar__action"
        onMouseDown={(e) => e.preventDefault()}
        onTouchStart={(e) => e.preventDefault()}
        onClick={handleCopy}
        title={t('reader.selectionToolbar.copy')}
        aria-label={t('reader.selectionToolbar.copy')}
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


function ExplainIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.663 17h4.673M12 3a7 7 0 0 0-4 12.75V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-1.25A7 7 0 0 0 12 3z" />
      <line x1="10" y1="21" x2="14" y2="21" />
    </svg>
  )
}

function AskAboutIcon() {
  // Sparkles — "help me understand" / agent assist.
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
      <path d="M19 14l.7 1.7L21.5 16.5l-1.8.8L19 19l-.7-1.7L16.5 16.5l1.8-.8L19 14z" />
    </svg>
  )
}

function SpeakIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  )
}
