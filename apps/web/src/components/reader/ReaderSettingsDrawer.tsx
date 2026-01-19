import type { ReaderSettings, Theme, FontFamily, TextAlign } from '../../hooks/useReaderSettings'
import { useFocusTrap } from '../../hooks/useFocusTrap'

interface Props {
  open: boolean
  settings: ReaderSettings
  onUpdate: (partial: Partial<ReaderSettings>) => void
  onClose: () => void
}

const themes: { value: Theme; label: string; bg: string }[] = [
  { value: 'light', label: 'Light', bg: '#fff' },
  { value: 'sepia', label: 'Sepia', bg: '#f4ecd8' },
  { value: 'dark', label: 'Dark', bg: '#1a1a1a' },
]

const fonts: { value: FontFamily; label: string; fontFamily: string }[] = [
  { value: 'serif', label: 'Serif', fontFamily: 'Georgia, serif' },
  { value: 'sans', label: 'Sans', fontFamily: 'sans-serif' },
  { value: 'dyslexic', label: 'Dyslexic', fontFamily: '"OpenDyslexic", sans-serif' },
]

const alignments: { value: TextAlign; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'justify', label: 'Justify' },
]

const lineHeights = [1.5, 1.65, 1.8]

export function ReaderSettingsDrawer({ open, settings, onUpdate, onClose }: Props) {
  const containerRef = useFocusTrap(open)

  if (!open) return null

  return (
    <>
      <div className="reader-drawer-backdrop" onClick={onClose} />
      <div className="reader-settings-drawer" ref={containerRef} role="dialog" aria-modal="true" aria-label="Reading Settings">
        <div className="reader-settings-drawer__header">
          <h3>Reading Settings</h3>
          <button onClick={onClose} className="reader-settings-drawer__close">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="reader-settings-drawer__section">
          <label>Font Size</label>
          <div className="reader-settings-drawer__font-size">
            <button
              onClick={() => onUpdate({ fontSize: Math.max(14, settings.fontSize - 2) })}
              disabled={settings.fontSize <= 14}
            >
              A-
            </button>
            <span>{settings.fontSize}px</span>
            <button
              onClick={() => onUpdate({ fontSize: Math.min(28, settings.fontSize + 2) })}
              disabled={settings.fontSize >= 28}
            >
              A+
            </button>
          </div>
        </div>

        <div className="reader-settings-drawer__section">
          <label>Line Height</label>
          <div className="reader-settings-drawer__options">
            {lineHeights.map((lh) => (
              <button
                key={lh}
                className={settings.lineHeight === lh ? 'active' : ''}
                onClick={() => onUpdate({ lineHeight: lh })}
              >
                {lh}
              </button>
            ))}
          </div>
        </div>

        <div className="reader-settings-drawer__section">
          <label>Text Align</label>
          <div className="reader-settings-drawer__options">
            {alignments.map((a) => (
              <button
                key={a.value}
                className={settings.textAlign === a.value ? 'active' : ''}
                onClick={() => onUpdate({ textAlign: a.value })}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <div className="reader-settings-drawer__section">
          <label>Theme</label>
          <div className="reader-settings-drawer__themes">
            {themes.map((t) => (
              <button
                key={t.value}
                className={`reader-settings-drawer__theme ${settings.theme === t.value ? 'active' : ''}`}
                style={{ backgroundColor: t.bg }}
                onClick={() => onUpdate({ theme: t.value })}
                title={t.label}
              />
            ))}
          </div>
        </div>

        <div className="reader-settings-drawer__section">
          <label>Font</label>
          <div className="reader-settings-drawer__options">
            {fonts.map((f) => (
              <button
                key={f.value}
                className={settings.fontFamily === f.value ? 'active' : ''}
                onClick={() => onUpdate({ fontFamily: f.value })}
                style={{ fontFamily: f.fontFamily }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
