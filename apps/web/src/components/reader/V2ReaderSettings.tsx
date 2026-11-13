import { useEffect, useMemo, useState } from 'react'
// ponytail: a deep import of apps/mobile source, as V2ReaderHost.tsx's (the page's modules live there, #1128).
import {
  ALIGNS, FAMILIES, FONT_MAX, FONT_MIN, FONT_STEP, LINE_HEIGHTS, SETTINGS_KEY, THEMES, choose, parseChosen, readSettings,
  type V2FontFamily, type V2Settings, type V2TextAlign, type V2Theme,
} from '../../../../mobile/src/lib/v2reader/settings.mjs'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useTranslation } from '../../hooks/useTranslation'
import { readItem, writeItem } from '../../lib/safeLocalStorage'

/**
 * The V2 reader's settings on this device (#1260): the reader's choices in localStorage (settings.mjs reads them:
 * a damaged or older value is no choice), the page's whole settings object, and the theme on <html>, which is
 * what colours the bars (reader.css `data-theme`, the legacy reader's own switch).
 */
export function useV2ReaderSettings() {
  const [chosen, setChosen] = useState(() => parseChosen(readItem(SETTINGS_KEY)))
  const settings = useMemo(() => readSettings(chosen), [chosen])
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    return () => { delete document.documentElement.dataset.theme }
  }, [settings.theme])
  const update = (patch: Partial<V2Settings>) => {
    const next = choose(chosen, patch)
    setChosen(next)
    writeItem(SETTINGS_KEY, JSON.stringify(next))
  }
  return { settings, update }
}

const ALIGN_LABEL: Record<V2TextAlign, string> = { left: 'v2Reader.alignLeft', center: 'v2Reader.alignCenter', justify: 'v2Reader.alignJustify' }
const FAMILY_LABEL: Record<V2FontFamily, string> = { serif: 'v2Reader.fontSerif', sans: 'v2Reader.fontSans', dyslexic: 'v2Reader.fontDyslexic' }
const THEME_LABEL: Record<V2Theme, string> = { light: 'v2Reader.themeLight', sepia: 'v2Reader.themeSepia', dark: 'v2Reader.themeDark' }

interface Props {
  open: boolean
  settings: V2Settings
  onUpdate: (patch: Partial<V2Settings>) => void
  onClose: () => void
  /** False for a fixed-layout book (PDF, CBZ, a pre-paginated EPUB): only the theme applies, the rest is disabled. */
  typography: boolean
}

/** The settings panel: the legacy reader's drawer (reader.css) with the five V2 settings. */
export function V2ReaderSettingsDrawer({ open, settings, onUpdate, onClose, typography }: Props) {
  const { t } = useTranslation()
  const container = useFocusTrap(open)
  if (!open) return null
  return (
    <>
      <div className="reader-drawer-backdrop" onClick={onClose} />
      <div
        className="reader-settings-drawer"
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-label={t('v2Reader.settings')}
        data-testid="v2-settings"
        // Escape closes the panel and goes no further (the host's own Escape shows the bars).
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
      >
        <div className="reader-settings-drawer__header">
          <h3>{t('v2Reader.settings')}</h3>
          <button onClick={onClose} className="reader-settings-drawer__close" aria-label={t('v2Reader.settingsClose')}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="reader-settings-drawer__section">
          <label>{t('v2Reader.theme')}</label>
          <div className="reader-settings-drawer__themes">
            {(Object.keys(THEMES) as V2Theme[]).map((theme) => (
              <button
                key={theme}
                className={`reader-settings-drawer__theme ${settings.theme === theme ? 'active' : ''}`}
                style={{ backgroundColor: THEMES[theme].bg }}
                onClick={() => onUpdate({ theme })}
                aria-label={t(THEME_LABEL[theme])}
                aria-pressed={settings.theme === theme}
                title={t(THEME_LABEL[theme])}
              />
            ))}
          </div>
        </div>

        {/* A fieldset disables every control in it at once. */}
        <fieldset className="v2-reader__typography" disabled={!typography} data-testid="v2-settings-typography">
          {!typography && <p className="v2-reader__fixed-note">{t('v2Reader.fixedLayout')}</p>}
          <div className="reader-settings-drawer__section">
            <label>{t('v2Reader.fontSize')}</label>
            <div className="reader-settings-drawer__font-size">
              <button onClick={() => onUpdate({ fontSize: settings.fontSize - FONT_STEP })} disabled={settings.fontSize <= FONT_MIN} aria-label={t('v2Reader.fontSmaller')}>A-</button>
              <span data-testid="v2-font-size">{settings.fontSize}px</span>
              <button onClick={() => onUpdate({ fontSize: settings.fontSize + FONT_STEP })} disabled={settings.fontSize >= FONT_MAX} aria-label={t('v2Reader.fontLarger')}>A+</button>
            </div>
          </div>

          <div className="reader-settings-drawer__section">
            <label>{t('v2Reader.font')}</label>
            <div className="reader-settings-drawer__options">
              {FAMILIES.map((fontFamily) => (
                <button key={fontFamily} className={settings.fontFamily === fontFamily ? 'active' : ''} aria-pressed={settings.fontFamily === fontFamily} onClick={() => onUpdate({ fontFamily })}>
                  {t(FAMILY_LABEL[fontFamily])}
                </button>
              ))}
            </div>
          </div>

          <div className="reader-settings-drawer__section">
            <label>{t('v2Reader.lineHeight')}</label>
            <div className="reader-settings-drawer__options">
              {LINE_HEIGHTS.map((lineHeight) => (
                <button key={lineHeight} className={settings.lineHeight === lineHeight ? 'active' : ''} aria-pressed={settings.lineHeight === lineHeight} onClick={() => onUpdate({ lineHeight })}>
                  {lineHeight}
                </button>
              ))}
            </div>
          </div>

          <div className="reader-settings-drawer__section">
            <label>{t('v2Reader.textAlign')}</label>
            <div className="reader-settings-drawer__options">
              {ALIGNS.map((textAlign) => (
                <button key={textAlign} className={settings.textAlign === textAlign ? 'active' : ''} aria-pressed={settings.textAlign === textAlign} onClick={() => onUpdate({ textAlign })}>
                  {t(ALIGN_LABEL[textAlign])}
                </button>
              ))}
            </div>
          </div>
        </fieldset>
      </div>
    </>
  )
}
