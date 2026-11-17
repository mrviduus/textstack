import { useTranslation } from '../../hooks/useTranslation'

interface Props {
  count: number
  onCancel: () => void
  onSelectAll: () => void
  onMarkFinished: () => void
  onDelete: () => void
  busy?: boolean
}

export function BulkActionBar({ count, onCancel, onSelectAll, onMarkFinished, onDelete, busy }: Props) {
  const { t } = useTranslation()

  return (
    <div className="bulk-action-bar" role="toolbar" aria-label="Bulk actions">
      <div className="bulk-action-bar__count">{t('library.bulk.selectedCount').replace('{n}', String(count))}</div>
      <button type="button" className="bulk-action-bar__btn" onClick={onSelectAll} disabled={busy}>
        {t('library.bulk.selectAll')}
      </button>
      <button type="button" className="bulk-action-bar__btn" onClick={onMarkFinished} disabled={busy || count === 0}>
        {t('library.bulk.markFinished')}
      </button>
      <button type="button" className="bulk-action-bar__btn bulk-action-bar__btn--danger" onClick={onDelete} disabled={busy || count === 0}>
        {t('library.bulk.delete')}
      </button>
      <button type="button" className="bulk-action-bar__btn bulk-action-bar__btn--ghost" onClick={onCancel}>
        {t('library.bulk.cancel')}
      </button>
    </div>
  )
}
