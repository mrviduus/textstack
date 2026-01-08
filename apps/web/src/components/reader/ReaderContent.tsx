import { useCallback, forwardRef } from 'react'
import type { ReaderSettings } from '../../hooks/useReaderSettings'

interface Props {
  html: string
  settings: ReaderSettings
  onTap: () => void
  containerRef?: React.RefObject<HTMLDivElement | null>
}

function getFontFamily(family: ReaderSettings['fontFamily']): string {
  switch (family) {
    case 'serif': return 'Georgia, "Times New Roman", serif'
    case 'sans': return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    case 'dyslexic': return '"OpenDyslexic", sans-serif'
  }
}

export const ReaderContent = forwardRef<HTMLElement, Props>(
  function ReaderContent({ html, settings, onTap, containerRef }, ref) {
    const fontFamily = getFontFamily(settings.fontFamily)

    const handleClick = useCallback((e: React.MouseEvent) => {
      // Don't toggle bar when clicking links (footnotes, etc.)
      const target = e.target as HTMLElement
      if (target.tagName === 'A' || target.closest('a')) {
        return
      }
      onTap()
    }, [onTap])

    return (
      <div className="reader-content-wrapper" ref={containerRef as React.RefObject<HTMLDivElement>} onClick={handleClick}>
        <article
          ref={ref as React.RefObject<HTMLElement>}
          className="reader-content"
          style={{
            fontSize: `${settings.fontSize}px`,
            lineHeight: settings.lineHeight,
            fontFamily,
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    )
  }
)
