import { useEffect, useState } from 'react'
import { useTranslation } from '../../hooks/useTranslation'
import { useUserTags } from '../../hooks/useUserTags'
import { useCollections } from '../../hooks/useCollections'
import { useV2 } from '../../context/AuthContext'
import { v2Offers } from '@textstack/shared'
import type { LibrarySource } from '../../hooks/useLibrarySource'

const TAG_LIMIT = 10

interface Counts {
  all: number
  uploads: number
  catalog: number
}

interface Props {
  source: LibrarySource
  tag: string | null
  collection: string | null
  counts: Counts
  onSourceChange: (next: LibrarySource) => void
  onTagChange: (next: string | null) => void
  onCollectionChange: (next: string | null) => void
  /** True when the sidebar is the mobile drawer and currently visible.
   *  Used purely to reset transient form state when the drawer hides. */
  drawerOpen?: boolean
}

export function LibrarySidebar({
  source, tag, collection, counts,
  onSourceChange, onTagChange, onCollectionChange,
  drawerOpen,
}: Props) {
  const { t } = useTranslation()
  const { tags } = useUserTags()
  // V2 (#1031): no catalog shelf, no collections.
  const v2 = useV2()
  const { collections, create } = useCollections()
  const [creatingCollection, setCreatingCollection] = useState(false)
  const [newCollectionName, setNewCollectionName] = useState('')
  const [busyCreate, setBusyCreate] = useState(false)

  // Mobile drawer hides via CSS class but stays mounted; reset the create
  // form on close so re-opening doesn't surface stale typed state. On
  // desktop drawerOpen is undefined so this effect no-ops (the sidebar
  // is always visible there anyway).
  useEffect(() => {
    if (drawerOpen === false) {
      setCreatingCollection(false)
      setNewCollectionName('')
    }
  }, [drawerOpen])

  const visibleTags = tags.slice(0, TAG_LIMIT)
  const moreTags = tags.length > TAG_LIMIT

  const handleCreateCollection = async () => {
    const trimmed = newCollectionName.trim()
    if (!trimmed || busyCreate) return
    setBusyCreate(true)
    try {
      const c = await create(trimmed)
      onCollectionChange(c.id)
      setNewCollectionName('')
      setCreatingCollection(false)
    } finally {
      setBusyCreate(false)
    }
  }

  const isSourceActive = (s: LibrarySource) => source === s && !tag && !collection

  return (
    <nav className="library-sidebar-v3" aria-label={t('library.title')}>
      <div className="library-sidebar-v3__section">
        <button
          type="button"
          className={`library-sidebar-v3__item ${isSourceActive('all') ? 'library-sidebar-v3__item--active' : ''}`}
          onClick={() => onSourceChange('all')}
        >
          <span className="material-icons-outlined">book</span>
          <span className="library-sidebar-v3__label">{t('library.sidebar.all')}</span>
          <span className="library-sidebar-v3__count">{counts.all}</span>
        </button>
        <button
          type="button"
          className={`library-sidebar-v3__item ${isSourceActive('uploads') ? 'library-sidebar-v3__item--active' : ''}`}
          onClick={() => onSourceChange('uploads')}
        >
          <span className="material-icons-outlined">file_upload</span>
          <span className="library-sidebar-v3__label">{t('library.sidebar.uploads')}</span>
          <span className="library-sidebar-v3__count">{counts.uploads}</span>
        </button>
        {v2Offers(v2, 'catalog') && <button
          type="button"
          className={`library-sidebar-v3__item ${isSourceActive('catalog') ? 'library-sidebar-v3__item--active' : ''}`}
          onClick={() => onSourceChange('catalog')}
        >
          <span className="material-icons-outlined">bookmark</span>
          <span className="library-sidebar-v3__label">{t('library.sidebar.catalog')}</span>
          <span className="library-sidebar-v3__count">{counts.catalog}</span>
        </button>}
      </div>

      {visibleTags.length > 0 && (
        <div className="library-sidebar-v3__section">
          <h3 className="library-sidebar-v3__heading">{t('library.sidebar.tags')}</h3>
          {visibleTags.map((entry) => (
            <button
              key={entry.tag}
              type="button"
              className={`library-sidebar-v3__item library-sidebar-v3__item--tag ${tag === entry.tag ? 'library-sidebar-v3__item--active' : ''}`}
              onClick={() => onTagChange(tag === entry.tag ? null : entry.tag)}
            >
              <span className="library-sidebar-v3__tag-dot" />
              <span className="library-sidebar-v3__label">#{entry.tag}</span>
              <span className="library-sidebar-v3__count">{entry.count}</span>
            </button>
          ))}
          {moreTags && (
            <button
              type="button"
              className="library-sidebar-v3__more"
              onClick={() => onSourceChange('uploads')}
            >
              {t('library.sidebar.allTags')}
            </button>
          )}
        </div>
      )}

      {v2Offers(v2, 'collections') && <div className="library-sidebar-v3__section">
        <h3 className="library-sidebar-v3__heading">{t('library.sidebar.collections')}</h3>
        {collections.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`library-sidebar-v3__item library-sidebar-v3__item--collection ${collection === c.id ? 'library-sidebar-v3__item--active' : ''}`}
            onClick={() => onCollectionChange(collection === c.id ? null : c.id)}
          >
            <span className={`library-sidebar-v3__collection-swatch library-sidebar-v3__collection-swatch--${c.color}`} />
            <span className="library-sidebar-v3__label">{c.name}</span>
            <span className="library-sidebar-v3__count">{c.count}</span>
          </button>
        ))}
        {creatingCollection ? (
          <form
            className="library-sidebar-v3__new-form"
            onSubmit={(e) => { e.preventDefault(); handleCreateCollection() }}
          >
            <input
              type="text"
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.target.value)}
              placeholder={t('library.collections.newPlaceholder')}
              maxLength={100}
              autoFocus
              disabled={busyCreate}
            />
            <div className="library-sidebar-v3__new-actions">
              <button type="submit" disabled={busyCreate || !newCollectionName.trim()}>
                {t('library.collections.add')}
              </button>
              <button type="button" onClick={() => { setCreatingCollection(false); setNewCollectionName('') }}>
                ×
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="library-sidebar-v3__more"
            onClick={() => setCreatingCollection(true)}
          >
            {t('library.sidebar.newCollection')}
          </button>
        )}
      </div>}
    </nav>
  )
}
