import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useTranslation } from '../hooks/useTranslation'
import { platform } from '../platform'

interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  /** Extra class of the panel (its width on desktop; a hook for tests). */
  className?: string
  children: ReactNode
}

/** A drag of the handle past this many pixels closes the sheet. */
const DISMISS_PX = 80

/**
 * A dialog over the page. On a phone-width screen it is a bottom sheet with a handle that drags it away; above
 * that, a centred dialog (styles/sheet.css). It closes on Escape, a tap outside, the close button and the
 * Android Back key; it holds the focus and stops the page behind it from scrolling.
 */
export function Sheet({ open, onClose, title, className, children }: SheetProps) {
  const panelRef = useFocusTrap(open)
  const { t } = useTranslation()
  // The newest `onClose`, so the effects below do not run again when the caller passes a new function.
  const close = useRef(onClose)
  close.current = onClose
  const drag = useRef<{ startY: number; dy: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current() }
    document.addEventListener('keydown', onKey)
    const offBack = platform.onBackButton(() => close.current())
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      offBack()
      document.body.style.overflow = overflow
    }
  }, [open])

  if (!open) return null

  const panel = () => panelRef.current
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { startY: e.clientY, dy: 0 }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    // The panel follows the finger from here: the rise animation and the ease of an earlier spring-back stop.
    if (panel()) Object.assign(panel()!.style, { animation: 'none', transition: '' })
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !panel()) return
    drag.current.dy = Math.max(0, e.clientY - drag.current.startY)
    panel()!.style.transform = `translateY(${drag.current.dy}px)`
  }
  /** The drag ends: far enough down closes; else the panel eases back. A cancelled drag (`close: false`) never closes. */
  const endDrag = (mayClose: boolean) => {
    const dy = drag.current?.dy ?? 0
    drag.current = null
    if (mayClose && dy > DISMISS_PX) return close.current()
    if (panel()) Object.assign(panel()!.style, { transition: 'transform 0.15s ease-out', transform: '' })
  }

  return createPortal(
    <div className="sheet__overlay" onClick={() => close.current()} role="presentation">
      <div
        ref={panelRef}
        className={className ? `sheet ${className}` : 'sheet'}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div
          className="sheet__handle"
          aria-hidden="true"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => endDrag(true)}
          onPointerCancel={() => endDrag(false)}
        />
        <button className="sheet__close" onClick={() => close.current()} aria-label={t('common.close')} type="button">
          &times;
        </button>
        <h2 className="sheet__title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  )
}
