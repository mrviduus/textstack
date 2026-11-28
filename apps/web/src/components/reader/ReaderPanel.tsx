import { useEffect, useRef, type ReactNode } from 'react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { usePhone } from '../../hooks/usePhone'
import { platform } from '../../platform'
import { Sheet } from '../Sheet'

interface Props {
  open: boolean
  onClose: () => void
  /** The dialog's name; on a phone also the sheet's title. */
  label: string
  /** The side drawer's class (reader.css). */
  className: string
  /**
   * After the trap's own focus (the first control), focus goes to the first match of this selector, if any.
   * On a phone with no match: to the panel's first control (the sheet's trap chose its close button). The panel's
   * own close button does not count: reader.css hides it in a sheet.
   */
  focus?: string
  testId?: string
  /** A function: nothing is built while the panel is closed. */
  children: () => ReactNode
}

/**
 * A reader panel (contents, search, settings). On a phone-width screen it opens in `Sheet`, a bottom sheet with
 * the title, the close button, Escape and the Android Back key. Above that it is the side drawer (reader.css):
 * a dialog that holds the focus and closes on Escape and the Back key. It stays mounted while closed, so closing gives focus back.
 */
export function ReaderPanel({ open, onClose, label, className, focus, testId, children }: Props) {
  const phone = usePhone()
  // On a phone the sheet holds the focus; `container` is then only where `focus` is looked for.
  const container = useFocusTrap(open && !phone)
  useEffect(() => {
    if (!open) return
    const c = container.current
    const to = (focus && c?.querySelector<HTMLElement>(focus)) || (phone ? c?.querySelector<HTMLElement>('input, button:not([class$="__close"])') : null)
    to?.focus()
  }, [open])
  // The Android Back key closes the drawer too (a wide screen in the app). The sheet takes Back itself.
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => (open && !phone ? platform.onBackButton(() => close.current()) : undefined), [open, phone])
  if (phone) {
    return (
      <Sheet open={open} onClose={onClose} title={label} className="reader-sheet">
        <div ref={container} className="reader-sheet__body" data-testid={testId}>{open && children()}</div>
      </Sheet>
    )
  }
  if (!open) return null
  return (
    <>
      <div className="reader-drawer-backdrop" onClick={onClose} />
      <div
        className={className}
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid={testId}
        // The reader's own keys (arrows, Space, Esc: the bars) stay out of the dialog; Tab goes on to the focus trap.
        onKeyDown={(e) => {
          if (e.key !== 'Tab') e.stopPropagation()
          if (e.key === 'Escape') onClose()
        }}
      >
        {children()}
      </div>
    </>
  )
}
