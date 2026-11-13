import { useEffect } from 'react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useTranslation } from '../../hooks/useTranslation'
import { tocAround, type V2TocEntry } from '../../../../mobile/src/lib/v2reader/toc.mjs'

/** `toc` through `readToc`, `tocIndex` through `readRelocate` (toc.mjs: the book is untrusted); `onGo`: the entry the reader chose. */
interface Props {
  toc: V2TocEntry[]
  tocIndex: number | null
  onGo: (entry: V2TocEntry) => void
}

/**
 * The V2 reader's table of contents (#1261): the legacy drawer's dialog (reader.css, `useFocusTrap`), the entries
 * indented by depth, the current one marked and focused on open (which scrolls it into view). Closing gives focus back.
 */
export function V2TocDrawer({ open, toc, tocIndex, onGo, onClose }: Props & { open: boolean; onClose: () => void }) {
  const container = useFocusTrap(open)
  const { t } = useTranslation()
  // After the trap's own focus (the close button).
  useEffect(() => {
    if (open) container.current?.querySelector<HTMLElement>('[aria-current]')?.focus()
  }, [open])
  if (!open) return null
  const { current } = tocAround(toc, tocIndex)
  return (
    <>
      <div className="reader-drawer-backdrop" onClick={onClose} />
      <div
        className="reader-toc-drawer"
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-label={t('v2Reader.contents')}
        // The reader's own keys (arrows, Space, Esc: the bars) stay out of the dialog; Tab goes on to the focus trap.
        onKeyDown={(e) => {
          if (e.key !== 'Tab') e.stopPropagation()
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="reader-toc-drawer__header">
          <h3>{t('v2Reader.contents')}</h3>
          <button onClick={onClose} className="reader-toc-drawer__close" aria-label={t('v2Reader.closeContents')}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <ul className="reader-toc-drawer__list">
          {toc.map((e) => (
            <li key={e.index}>
              <button
                type="button"
                className={`reader-toc-drawer__item reader-toc-drawer__hl-item${e === current ? ' active' : ''}`}
                aria-current={e === current ? 'true' : undefined}
                data-depth={e.depth}
                style={{ paddingLeft: 16 + e.depth * 16 }}
                onClick={() => {
                  onGo(e)
                  onClose()
                }}
              >
                <span className="reader-toc-drawer__title">{e.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

/** The entries before and after the reader's place, by title (#1261): never a number. None on a book with no contents. */
export function V2SectionNav({ toc, tocIndex, onGo }: Props) {
  const { t } = useTranslation()
  const { prev, next } = tocAround(toc, tocIndex)
  if (!prev && !next) return null
  return (
    <div className="v2-reader__sections">
      {prev && (
        <button className="reader-top-bar__btn" data-testid="v2-prev-section" aria-label={t('v2Reader.prevSection', { title: prev.label })} onClick={() => onGo(prev)}>
          ‹ {prev.label}
        </button>
      )}
      {next && (
        <button className="reader-top-bar__btn v2-reader__section-next" data-testid="v2-next-section" aria-label={t('v2Reader.nextSection', { title: next.label })} onClick={() => onGo(next)}>
          {next.label} ›
        </button>
      )}
    </div>
  )
}
