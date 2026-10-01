import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../hooks/useTranslation'
import { useCollections, invalidateCollectionsCache } from '../../hooks/useCollections'
import { collectionsApi, type CollectionBookType as BookType } from '@textstack/shared'

export type Toast = { msg: string; tone: 'success' | 'error' }

interface CommonProps {
  bookId: string
  bookType: BookType
  onToast?: (toast: Toast) => void
}

interface MenuVariantProps extends CommonProps {
  variant: 'menu'
  close: () => void
}

interface ButtonVariantProps extends CommonProps {
  variant: 'button'
  className?: string
  /** Render a circular `+` icon instead of the text label. */
  iconOnly?: boolean
}

type Props = MenuVariantProps | ButtonVariantProps

export function AddToCollectionButton(props: Props) {
  const { t } = useTranslation()
  const { collections, create } = useCollections()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [localToast, setLocalToast] = useState<Toast | null>(null)
  const [creatingNew, setCreatingNew] = useState(false)
  const [newName, setNewName] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!localToast) return
    const ms = localToast.tone === 'error' ? 4000 : 2500
    const id = window.setTimeout(() => setLocalToast(null), ms)
    return () => window.clearTimeout(id)
  }, [localToast])

  useEffect(() => {
    if (!expanded || props.variant !== 'button') return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setExpanded(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [expanded, props.variant])

  // Reset the inline create form whenever the popover closes — otherwise the
  // next open would land in create-mode with whatever was typed last time
  // instead of the collections list.
  useEffect(() => {
    if (!expanded) {
      setCreatingNew(false)
      setNewName('')
    }
  }, [expanded])

  const emitToast = (toast: Toast) => {
    if (props.onToast) props.onToast(toast)
    else setLocalToast(toast)
  }

  const handlePick = async (collectionId: string, name: string) => {
    if (busy) return
    setBusy(true)
    try {
      await collectionsApi.addBookToCollection(collectionId, props.bookId, props.bookType)
      invalidateCollectionsCache()
      emitToast({ msg: t('library.actions.addedToCollection', { name }), tone: 'success' })
      setExpanded(false)
      setCreatingNew(false)
      setNewName('')
      if (props.variant === 'menu') props.close()
    } catch {
      emitToast({ msg: t('library.actions.addToCollectionFailed'), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const handleCreateAndAdd = async () => {
    const trimmed = newName.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const c = await create(trimmed)
      await collectionsApi.addBookToCollection(c.id, props.bookId, props.bookType)
      invalidateCollectionsCache()
      emitToast({ msg: t('library.actions.addedToCollection', { name: c.name }), tone: 'success' })
      setExpanded(false)
      setCreatingNew(false)
      setNewName('')
      if (props.variant === 'menu') props.close()
    } catch {
      emitToast({ msg: t('library.actions.addToCollectionFailed'), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (props.variant === 'menu') {
    if (collections.length === 0) {
      return (
        <button
          className="book-card-menu__item"
          role="menuitem"
          disabled
          aria-disabled="true"
          title={t('library.actions.addToCollectionEmpty')}
        >
          {t('library.actions.addToCollection')}
        </button>
      )
    }
    return (
      <>
        <button
          className="book-card-menu__item"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={expanded}
          onClick={(e) => { e.preventDefault(); setExpanded((v) => !v) }}
        >
          {t('library.actions.addToCollection')}
          <span aria-hidden="true" style={{ marginLeft: 'auto', opacity: 0.6 }}>{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && (
          <div className="book-card-menu__submenu" role="menu">
            {collections.map((c) => (
              <button
                key={c.id}
                className="book-card-menu__item"
                role="menuitem"
                disabled={busy}
                onClick={() => handlePick(c.id, c.name)}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </>
    )
  }

  // variant === 'button'
  const iconOnly = !!props.iconOnly
  const baseClass = props.className
    || (iconOnly ? 'add-to-collection-button add-to-collection-button--icon' : 'add-to-collection-button')
  const label = t('library.actions.addToCollection')
  const buttonContent = iconOnly ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ) : label
  const isEmpty = collections.length === 0
  return (
    <div className="add-to-collection" ref={wrapRef}>
      {localToast && (
        <div className={`add-to-collection__toast add-to-collection__toast--${localToast.tone}`} role="status" aria-live="polite">
          {localToast.msg}
        </div>
      )}
      <button
        type="button"
        className={baseClass}
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-label={iconOnly ? label : undefined}
        onClick={() => {
          // Only flip into create-mode when *opening* the popover in empty
          // state — otherwise toggling closed → open from non-empty to
          // empty (cache invalidation race) would land in a stale form.
          if (!expanded && isEmpty) setCreatingNew(true)
          setExpanded((v) => !v)
        }}
      >
        {buttonContent}
      </button>
      {expanded && (
        <div className="add-to-collection__popover" role="menu">
          {collections.map((c) => (
            <button
              key={c.id}
              type="button"
              className="add-to-collection__option"
              role="menuitem"
              disabled={busy}
              onClick={() => handlePick(c.id, c.name)}
            >
              {c.name}
            </button>
          ))}
          {creatingNew ? (
            <form
              className="add-to-collection__create"
              onSubmit={(e) => { e.preventDefault(); handleCreateAndAdd() }}
            >
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('library.collections.newPlaceholder')}
                maxLength={100}
                autoFocus
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setCreatingNew(false)
                    setNewName('')
                  }
                }}
              />
              <button type="submit" disabled={busy || !newName.trim()}>
                {t('library.collections.add')}
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="add-to-collection__option add-to-collection__option--new"
              role="menuitem"
              disabled={busy}
              onClick={() => setCreatingNew(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {t('library.collections.new')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
