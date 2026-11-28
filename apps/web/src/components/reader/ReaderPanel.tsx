import { useEffect, type ReactNode } from 'react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { usePhone } from '../../hooks/usePhone'
import { Sheet } from '../Sheet'

interface Props {
  open: boolean
  onClose: () => void
  /** The dialog's name; on a phone also the sheet's title. */
  label: string
  /** The side drawer's class (reader.css). */
  className: string
  /** After the trap's own focus (the first control), focus goes to the first match of this selector, if any. */
  focus?: string
  testId?: string
  /** A function: nothing is built while the panel is closed. */
  children: () => ReactNode
}

/**
 * A reader panel (contents, search, settings). On a phone-width screen it opens in `Sheet`, a bottom sheet with
 * the title, the close button, Escape and the Android Back key. Above that it is the side drawer (reader.css):
 * a dialog that holds the focus and closes on Escape. It stays mounted while closed, so closing gives focus back.
 */
export function ReaderPanel({ open, onClose, label, className, focus, testId, children }: Props) {
  const phone = usePhone()
  // On a phone the sheet holds the focus; `container` is then only where `focus` is looked for.
  const container = useFocusTrap(open && !phone)
  useEffect(() => {
    if (open && focus) container.current?.querySelector<HTMLElement>(focus)?.focus()
  }, [open])
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
