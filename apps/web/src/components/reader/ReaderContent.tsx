import type { ReaderSettings } from '../../hooks/useReaderSettings'
import { getColumnMaxWidth } from '../../hooks/useReaderSettings'

interface Props {
  html: string
  settings: ReaderSettings
  onTap: () => void
}

function getFontFamily(family: ReaderSettings['fontFamily']): string {
  switch (family) {
    case 'serif': return 'Georgia, "Times New Roman", serif'
    case 'sans': return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    case 'dyslexic': return '"OpenDyslexic", sans-serif'
  }
}

export function ReaderContent({ html, settings, onTap }: Props) {
  const fontFamily = getFontFamily(settings.fontFamily)

  return (
    <article
      className="reader-content"
      onClick={onTap}
      style={{
        maxWidth: getColumnMaxWidth(settings.columnWidth),
        fontSize: `${settings.fontSize}px`,
        lineHeight: settings.lineHeight,
        fontFamily,
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
