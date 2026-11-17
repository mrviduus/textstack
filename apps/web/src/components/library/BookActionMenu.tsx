import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from '../../hooks/useTranslation'
import { useLanguage } from '../../context/LanguageContext'
import { useBookActions } from '../../hooks/useBookActions'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'
import type { UserBook } from '../../api/userBooks'

type UserBookProps = {
  book: UserBook
  onChange: () => void
}

export function BookActionMenu(props: UserBookProps) {
  const { t } = useTranslation()
  const { language } = useLanguage()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); return }
      if (!wrapRef.current) return
      const items = Array.from(
        wrapRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled]):not([aria-disabled="true"])'),
      )
      if (items.length === 0) return
      const idx = items.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        items[(idx + 1 + items.length) % items.length].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        items[(idx - 1 + items.length) % items.length].focus()
      } else if (e.key === 'Home') {
        e.preventDefault(); items[0].focus()
      } else if (e.key === 'End') {
        e.preventDefault(); items[items.length - 1].focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open || !wrapRef.current) return
    const first = wrapRef.current.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]):not([aria-disabled="true"])')
    first?.focus()
  }, [open])

  return (
    <UserBookMenu
      {...props}
      wrapRef={wrapRef}
      open={open}
      setOpen={setOpen}
      confirmDelete={confirmDelete}
      setConfirmDelete={setConfirmDelete}
      t={t}
      navigate={navigate}
      language={language}
    />
  )
}

interface SharedRender {
  wrapRef: React.RefObject<HTMLDivElement | null>
  open: boolean
  setOpen: (v: boolean) => void
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  t: (key: string, vars?: Record<string, string | number>) => string
  navigate: ReturnType<typeof useNavigate>
  language: string
}

function Trigger({ open, setOpen, t }: { open: boolean; setOpen: (v: boolean) => void; t: SharedRender['t'] }) {
  return (
    <button
      type="button"
      className="book-card-menu__trigger"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open) }}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={t('library.actions.menu')}
      title={t('library.actions.menu')}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="5" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="12" cy="19" r="2" />
      </svg>
    </button>
  )
}

type Toast = { msg: string; tone: 'success' | 'error' }

function UserBookMenu({
  book, onChange,
  wrapRef, open, setOpen, confirmDelete, setConfirmDelete, t, navigate, language,
}: UserBookProps & SharedRender) {
  const actions = useBookActions(book, { onChange })
  const isReady = book.status === 'Ready'
  const isFinished = !!book.completedAt
  const [toast, setToast] = useState<Toast | null>(null)

  useEffect(() => {
    if (!actions.error) return
    setToast({ msg: actions.error, tone: 'error' })
  }, [actions.error])

  useEffect(() => {
    if (!toast) return
    const ms = toast.tone === 'error' ? 4000 : 2500
    const id = window.setTimeout(() => setToast(null), ms)
    return () => window.clearTimeout(id)
  }, [toast])

  const close = () => setOpen(false)

  return (
    <div className="book-card-menu" ref={wrapRef}>
      {toast && (
        <div className={`book-card-menu__toast book-card-menu__toast--${toast.tone}`} role="status" aria-live="polite">
          {toast.msg}
        </div>
      )}
      <Trigger open={open} setOpen={setOpen} t={t} />
      {open && (
        <div className="book-card-menu__dropdown" role="menu">
          {isReady && (
            <button className="book-card-menu__item" role="menuitem" onClick={() => { close(); navigate(`/${language}/library/my/${book.id}`) }}>
              {t('library.actions.viewDetails')}
            </button>
          )}
          {isReady && book.chapterCount > 0 && (
            <button
              className="book-card-menu__item"
              role="menuitem"
              disabled={actions.pending === 'mark'}
              onClick={async () => { close(); await (isFinished ? actions.markUnfinished() : actions.markFinished()) }}
            >
              {isFinished ? t('library.actions.markUnfinished') : t('library.actions.markFinished')}
            </button>
          )}
          <div className="book-card-menu__divider" />
          <button
            className="book-card-menu__item book-card-menu__item--danger"
            role="menuitem"
            onClick={() => { close(); setConfirmDelete(true) }}
          >
            {t('library.actions.delete')}
          </button>
        </div>
      )}
      <ConfirmDeleteModal
        open={confirmDelete}
        title={t('library.actions.confirmDeleteTitle')}
        bodyTitle={book.title}
        busy={actions.pending === 'delete'}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => { await actions.remove(); setConfirmDelete(false) }}
      />
    </div>
  )
}
