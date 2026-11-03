import { useState } from 'react'
import { useTranslation } from '../../hooks/useTranslation'
import { useCollections } from '../../hooks/useCollections'
import { normalizeTag } from './TagInput'

export type BulkActionType = 'finish' | 'delete' | 'addTag' | 'addCollection'

interface Props {
  count: number
  onCancel: () => void
  onSelectAll: () => void
  onMarkFinished: () => void
  onDelete: () => void
  /** Absent: no tag menu (a V2 library has no tags). */
  onAddTag?: (tag: string) => void
  /** Absent: no collection menu (V2 has no collections). */
  onAddToCollection?: (id: string) => void
  busy?: boolean
}

export function BulkActionBar({
  count, onCancel, onSelectAll, onMarkFinished, onDelete, onAddTag, onAddToCollection, busy,
}: Props) {
  const { t } = useTranslation()
  const [openMenu, setOpenMenu] = useState<'tag' | 'collection' | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const { collections } = useCollections()

  const submitTag = () => {
    const t = normalizeTag(tagDraft)
    if (!t) return
    onAddTag?.(t)
    setTagDraft('')
    setOpenMenu(null)
  }

  return (
    <div className="bulk-action-bar" role="toolbar" aria-label="Bulk actions">
      <div className="bulk-action-bar__count">{t('library.bulk.selectedCount').replace('{n}', String(count))}</div>
      <button type="button" className="bulk-action-bar__btn" onClick={onSelectAll} disabled={busy}>
        {t('library.bulk.selectAll')}
      </button>
      <button type="button" className="bulk-action-bar__btn" onClick={onMarkFinished} disabled={busy || count === 0}>
        {t('library.bulk.markFinished')}
      </button>

      {onAddTag && <div className="bulk-action-bar__menu-wrap">
        <button type="button" className="bulk-action-bar__btn" onClick={() => setOpenMenu(openMenu === 'tag' ? null : 'tag')} disabled={busy || count === 0}>
          {t('library.bulk.addTag')} ▾
        </button>
        {openMenu === 'tag' && (
          <div className="bulk-action-bar__menu">
            <input
              type="text"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitTag() } }}
              placeholder={t('library.bulk.tagPlaceholder')}
              autoFocus
              maxLength={50}
            />
            <button type="button" onClick={submitTag} disabled={!normalizeTag(tagDraft)}>OK</button>
          </div>
        )}
      </div>}

      {onAddToCollection && <div className="bulk-action-bar__menu-wrap">
        <button type="button" className="bulk-action-bar__btn" onClick={() => setOpenMenu(openMenu === 'collection' ? null : 'collection')} disabled={busy || count === 0 || collections.length === 0}>
          {t('library.bulk.addToCollection')} ▾
        </button>
        {openMenu === 'collection' && (
          <div className="bulk-action-bar__menu bulk-action-bar__menu--list">
            {collections.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { onAddToCollection(c.id); setOpenMenu(null) }}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>}

      <button type="button" className="bulk-action-bar__btn bulk-action-bar__btn--danger" onClick={onDelete} disabled={busy || count === 0}>
        {t('library.bulk.delete')}
      </button>
      <button type="button" className="bulk-action-bar__btn bulk-action-bar__btn--ghost" onClick={onCancel}>
        {t('library.bulk.cancel')}
      </button>
    </div>
  )
}
