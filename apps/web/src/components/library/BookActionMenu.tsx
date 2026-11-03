import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from '../../hooks/useTranslation'
import { useLanguage } from '../../context/LanguageContext'
import { useV2 } from '../../context/AuthContext'
import { v2Offers } from '@textstack/shared'
import { useBookActions } from '../../hooks/useBookActions'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'
import { UserBookEditModal } from './UserBookEditModal'
import { AddToCollectionButton, type Toast as AddToast } from './AddToCollectionButton'
import type { LibraryItem } from '../../api/auth'
import type { UserBook } from '../../api/userBooks'

type SavedProps = {
  type: 'saved'
  book: LibraryItem
  isFinished: boolean
  onMarkFinished: () => void
  onMarkUnfinished: () => void
  onRemove: () => void
}

type UserBookProps = {
  type: 'userbook'
  book: UserBook
  onChange: () => void
}

type Props = SavedProps | UserBookProps

export function BookActionMenu(props: Props) {
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

  if (props.type === 'saved') {
    return (
      <SavedMenu
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

type Toast = AddToast

function SavedMenu({
  book, isFinished, onMarkFinished, onMarkUnfinished, onRemove,
  wrapRef, open, setOpen, confirmDelete, setConfirmDelete, t, navigate, language,
}: SavedProps & SharedRender) {
  const [toast, setToast] = useState<Toast | null>(null)
  useEffect(() => {
    if (!toast) return
    const ms = toast.tone === 'error' ? 4000 : 2500
    const id = window.setTimeout(() => setToast(null), ms)
    return () => window.clearTimeout(id)
  }, [toast])
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
          <button className="book-card-menu__item" role="menuitem" onClick={() => { setOpen(false); navigate(`/${language}/books/${book.slug}`) }}>
            {t('library.actions.viewDetails')}
          </button>
          <button
            className="book-card-menu__item"
            role="menuitem"
            onClick={() => { setOpen(false); isFinished ? onMarkUnfinished() : onMarkFinished() }}
          >
            {isFinished ? t('library.actions.markUnfinished') : t('library.actions.markFinished')}
          </button>
          <AddToCollectionButton
            variant="menu"
            bookId={book.editionId}
            bookType="savedbook"
            close={() => setOpen(false)}
            onToast={setToast}
          />
          <div className="book-card-menu__divider" />
          <button
            className="book-card-menu__item book-card-menu__item--danger"
            role="menuitem"
            onClick={() => { setOpen(false); setConfirmDelete(true) }}
          >
            {t('library.actions.removeFromLibrary')}
          </button>
        </div>
      )}
      <ConfirmDeleteModal
        open={confirmDelete}
        title={t('library.actions.confirmDeleteTitle')}
        bodyTitle={book.title}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); onRemove() }}
      />
    </div>
  )
}

function UserBookMenu({
  book, onChange,
  wrapRef, open, setOpen, confirmDelete, setConfirmDelete, t, navigate, language,
}: UserBookProps & SharedRender) {
  const actions = useBookActions(book, { onChange })
  const isReady = book.status === 'Ready'
  const isFailed = book.status === 'Failed'
  const isProcessing = book.status === 'Processing'
  const isFinished = !!book.completedAt
  // V2 (#1025): open, finish, delete; metadata, collections, retry and cancel have no V2 counterpart (V2_FEATURES).
  const v2 = useV2()
  const [toast, setToast] = useState<Toast | null>(null)
  const [editOpen, setEditOpen] = useState(false)

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
          {isReady && (!v2.enabled || book.chapterCount > 0) && (
            <button
              className="book-card-menu__item"
              role="menuitem"
              disabled={actions.pending === 'mark'}
              onClick={async () => { close(); await (isFinished ? actions.markUnfinished() : actions.markFinished()) }}
            >
              {isFinished ? t('library.actions.markUnfinished') : t('library.actions.markFinished')}
            </button>
          )}
          {isReady && v2Offers(v2, 'metadataEdit') && (
            <button
              className="book-card-menu__item"
              role="menuitem"
              onClick={() => { close(); setEditOpen(true) }}
            >
              {t('library.actions.editMetadata')}
            </button>
          )}
          {isReady && v2Offers(v2, 'collections') && (
            <AddToCollectionButton
              variant="menu"
              bookId={book.id}
              bookType="userbook"
              close={close}
              onToast={setToast}
            />
          )}
          {isFailed && v2Offers(v2, 'retry') && (
            <button
              className="book-card-menu__item"
              role="menuitem"
              disabled={actions.pending === 'retry'}
              onClick={async () => { close(); await actions.retry() }}
            >
              {actions.pending === 'retry' ? t('library.actions.retrying') : t('library.actions.retry')}
            </button>
          )}
          {isProcessing && v2Offers(v2, 'retry') && (
            <button
              className="book-card-menu__item book-card-menu__item--danger"
              role="menuitem"
              disabled={actions.pending === 'cancel'}
              onClick={async () => { close(); await actions.cancel() }}
            >
              {actions.pending === 'cancel' ? t('library.actions.cancelling') : t('library.actions.cancel')}
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
      <UserBookEditModal
        open={editOpen}
        book={book}
        onClose={() => setEditOpen(false)}
        onSaved={onChange}
      />
    </div>
  )
}
