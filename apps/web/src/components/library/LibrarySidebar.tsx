import { useTranslation } from '../../hooks/useTranslation'
import { useUserTags } from '../../hooks/useUserTags'
import type { LibrarySource } from '../../hooks/useLibrarySource'

const TAG_LIMIT = 10

interface Counts {
  all: number
}

interface Props {
  source: LibrarySource
  tag: string | null
  counts: Counts
  onSourceChange: (next: LibrarySource) => void
  onTagChange: (next: string | null) => void
}

export function LibrarySidebar({
  source, tag, counts,
  onSourceChange, onTagChange,
}: Props) {
  const { t } = useTranslation()
  const { tags } = useUserTags()
  const visibleTags = tags.slice(0, TAG_LIMIT)
  const moreTags = tags.length > TAG_LIMIT

  const isSourceActive = (s: LibrarySource) => source === s && !tag

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
              onClick={() => onSourceChange('all')}
            >
              {t('library.sidebar.allTags')}
            </button>
          )}
        </div>
      )}

    </nav>
  )
}
