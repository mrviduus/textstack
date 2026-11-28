import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'
import { useVocabulary } from '../hooks/useVocabulary'
import { useTts } from '../hooks/useTts'
import { REVIEW_BATCH_SIZES, DEFAULT_BATCH_SIZE } from '@textstack/shared'
import { SeoHead } from '../components/SeoHead'
import { SpeakButton } from '../components/vocabulary/SpeakButton'
import { EmptyState } from '../components/EmptyState'

function StageBadge({ stage, t }: { stage: number; t: (k: string) => string }) {
  return (
    <span className={`vocab-stage-badge vocab-stage-badge--${stage}`}>
      {t(`vocabulary.stages.${stage}`)}
    </span>
  )
}

function ProgressBar({ stage, label }: { stage: number; label?: string }) {
  return (
    <div className="vocab-word__progress-bar" aria-label={label || `Stage ${stage + 1} of 5`} title={label}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={[
            'vocab-word__progress-step',
            i <= stage ? 'vocab-word__progress-step--filled' : '',
            i === stage ? 'vocab-word__progress-step--current' : '',
          ].filter(Boolean).join(' ')}
        />
      ))}
    </div>
  )
}

function formatNextDue(nextReviewAt: string | null | undefined, t: (k: string) => string): string {
  if (!nextReviewAt) return ''
  const diffMs = new Date(nextReviewAt).getTime() - Date.now()
  if (diffMs <= 0) return t('vocabulary.due.now')
  const diffH = diffMs / 3_600_000
  if (diffH < 24) return t('vocabulary.due.today')
  const diffD = Math.ceil(diffH / 24)
  if (diffD === 1) return t('vocabulary.due.tomorrow')
  if (diffD <= 7) return t('vocabulary.due.inDays').replace('{n}', String(diffD))
  if (diffD <= 30) return t('vocabulary.due.inWeeks').replace('{n}', String(Math.ceil(diffD / 7)))
  return t('vocabulary.due.inMonths').replace('{n}', String(Math.ceil(diffD / 30)))
}

export function VocabularyPage() {
  const { isAuthenticated } = useAuth()
  const { getLocalizedPath } = useLanguage()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const {
    words, total, loading, error,
    filters, applyFilters, loadMore,
    removeWord, removeAll, editWord,
  } = useVocabulary()
  const { speak, isPlaying } = useTts()

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [activeTab, setActiveTab] = useState('all')
  const [search, setSearch] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)

  // Practice-widget state (lifted from old PracticePage)
  const [batchSize, setBatchSize] = useState(() => {
    const saved = parseInt(localStorage.getItem('practiceBatch') || '', 10)
    return (REVIEW_BATCH_SIZES as readonly number[]).includes(saved) ? saved : DEFAULT_BATCH_SIZE
  })

  if (loading && words.length === 0) {
    return (
      <div className="page-container">
        <SeoHead title={t('vocabulary.title')} noindex />
        <div className="vocab-page">
          <h1>{t('vocabulary.title')}</h1>
          <div className="vocab-loading">{t('common.loading')}</div>
        </div>
      </div>
    )
  }

  // Empty state for both guests (no auth) and fresh authenticated users with zero saved words
  if (!loading && words.length === 0 && !filters.search && !filters.stage) {
    return (
      <div className="page-container">
        <SeoHead title={t('vocabulary.title')} noindex />
        <div className="vocab-page">
          <h1>{t('vocabulary.title')}</h1>
          <EmptyState
            icon="📚"
            title={t('vocabulary.emptyPage.title')}
            subtitle={t('vocabulary.emptyPage.subtitle')}
            buttonLabel={t('vocabulary.emptyPage.cta')}
            buttonTo="/library"
          />
        </div>
      </div>
    )
  }

  const handleTabChange = (tab: string) => {
    setActiveTab(tab)
    const stageMap: Record<string, string | undefined> = {
      all: undefined,
      new: '0',
      learning: '1,2,3',
      mastered: '4',
    }
    applyFilters({ stage: stageMap[tab] })
  }

  const handleSearch = (value: string) => {
    setSearch(value)
    applyFilters({ search: value || undefined })
  }

  const handleSort = (sort: string) => {
    applyFilters({ sort })
  }

  const handleStartEdit = (id: string, currentTranslation: string) => {
    setEditingId(id)
    setEditValue(currentTranslation)
  }

  const handleSaveEdit = async (id: string) => {
    await editWord(id, { translation: editValue })
    setEditingId(null)
  }

  const handleDelete = async (id: string) => {
    if (deletingId === id) {
      await removeWord(id)
      setDeletingId(null)
    } else {
      setDeletingId(id)
      setTimeout(() => setDeletingId(prev => prev === id ? null : prev), 3000)
    }
  }

  const handleDeleteAll = async () => {
    if (confirmDeleteAll) {
      await removeAll()
      setConfirmDeleteAll(false)
    } else {
      setConfirmDeleteAll(true)
      setTimeout(() => setConfirmDeleteAll(false), 5000)
    }
  }

  const handleBatchChange = (n: number) => {
    setBatchSize(n)
    localStorage.setItem('practiceBatch', String(n))
  }

  const handleStartPractice = () => {
    const qs = batchSize !== DEFAULT_BATCH_SIZE ? `?limit=${batchSize}` : ''
    navigate(getLocalizedPath('/vocabulary/review') + qs)
  }

  // The current list counts; practice / delete-all stay while a filter or search may be hiding words.
  const hasWords = total > 0 || !!(filters.search || filters.stage)

  const practiceLabel = () => {
    const label = t('vocabulary.startPractice')
    const count = total > 0 ? Math.min(batchSize, total) : 0
    return count > 0 ? `${label} (${count} ${t('vocabulary.practice.wordsUnit')})` : label
  }

  return (
    <div className="page-container">
      <SeoHead title={t('vocabulary.title')} noindex />
      <div className="vocab-page">
        <div className="vocab-page__header">
          <h1>{t('vocabulary.title')}</h1>
        </div>

        {error && (
          <div className="vocab-error">{error}</div>
        )}

        {/* Start practice card (from Practice) */}
        {isAuthenticated && hasWords && (
          <div className="practice-page__card">
            <div className="practice-page__settings">
              <div className="practice-page__setting">
                <span className="practice-page__setting-label">{t('vocabulary.practice.length')}</span>
                <div className="review-summary__batch-row">
                  {REVIEW_BATCH_SIZES.map(n => (
                    <button
                      key={n}
                      className={`review-summary__batch-chip ${batchSize === n ? 'review-summary__batch-chip--active' : ''}`}
                      onClick={() => handleBatchChange(n)}
                    >
                      {n} {t('vocabulary.practice.wordsUnit')}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="practice-page__actions">
              <button
                className="practice-page__start-btn"
                onClick={handleStartPractice}
              >
                {practiceLabel()}
              </button>
            </div>
          </div>
        )}

        {/* Delete all */}
        {hasWords && (
          <div className="vocab-delete-all-row">
            <button
              className={`vocab-delete-all ${confirmDeleteAll ? 'vocab-delete-all--confirming' : ''}`}
              onClick={handleDeleteAll}
            >
              {confirmDeleteAll ? t('vocabulary.deleteAllConfirm') : t('vocabulary.deleteAll')}
            </button>
          </div>
        )}

        {/* Filters */}
        <div className="vocab-filters">
          <div className="vocab-tabs" role="tablist">
            {['all', 'new', 'learning', 'mastered'].map(tab => (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                className={`vocab-tab ${activeTab === tab ? 'vocab-tab--active' : ''}`}
                onClick={() => handleTabChange(tab)}
              >
                {t(`vocabulary.filters.${tab}`)}
              </button>
            ))}
          </div>
          <div className="vocab-controls">
            <input
              type="text"
              className="vocab-search"
              placeholder={t('vocabulary.filters.search')}
              aria-label={t('vocabulary.filters.search')}
              value={search}
              onChange={e => handleSearch(e.target.value)}
            />
            <select
              className="vocab-sort"
              value={filters.sort || 'recent'}
              onChange={e => handleSort(e.target.value)}
              aria-label={t('vocabulary.sort.recent')}
            >
              <option value="recent">{t('vocabulary.sort.recent')}</option>
              <option value="alphabetical">{t('vocabulary.sort.alphabetical')}</option>
              <option value="due">{t('vocabulary.sort.due')}</option>
              <option value="stage">{t('vocabulary.sort.stage')}</option>
            </select>
          </div>
        </div>

        {/* Word list */}
        {words.length === 0 ? (
          <EmptyState icon="📝" title={t('vocabulary.empty')} />
        ) : (
          <div className="vocab-list">
            <div className="vocab-list__header">
              <div className="vocab-list__heading">
                <h2 className="vocab-list__title">{t('vocabulary.listTitle')}</h2>
                <span className="vocab-list__count">{t('vocabulary.listCount').replace('{n}', String(total))}</span>
              </div>
              <p className="vocab-list__hint" title={t('vocabulary.srsHint')}>
                <span aria-hidden>↻</span> {t('vocabulary.srsHint')}
              </p>
            </div>
            <div className="vocab-list__columns" aria-hidden="true">
              <span className="vocab-list__col vocab-list__col--word">{t('vocabulary.columns.word')}</span>
              <span className="vocab-list__col vocab-list__col--translation">{t('vocabulary.columns.translation')}</span>
              <span className="vocab-list__col vocab-list__col--progress">{t('vocabulary.columns.progress')}</span>
              <span className="vocab-list__col vocab-list__col--due">{t('vocabulary.columns.nextDue')}</span>
            </div>
            {words.map(w => (
              <div
                key={w.id}
                className={`vocab-word ${expandedId === w.id ? 'vocab-word--expanded' : ''}`}
              >
                <div
                  className="vocab-word__row"
                  onClick={() => setExpandedId(expandedId === w.id ? null : w.id)}
                >
                  <div className="vocab-word__main">
                    <SpeakButton
                      onClick={() => speak(w.word, w.language)}
                      isPlaying={isPlaying}
                    />
                    <div className="vocab-word__word-cell">
                      <span className="vocab-word__text">{w.word}</span>
                      {w.bookTitle && (
                        <span className="vocab-word__book" title={w.bookTitle}>
                          <span className="vocab-word__book-icon" aria-hidden>📖</span>
                          {t('vocabulary.fromBook').replace('{title}', w.bookTitle)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="vocab-word__meta">
                    {w.translation && (
                      <span className="vocab-word__translation">{w.translation}</span>
                    )}
                    <ProgressBar
                      stage={w.stage}
                      label={`${t(`vocabulary.stages.${w.stage}`)}${w.totalReviews > 0 ? ` · ${Math.round(w.correctReviews / w.totalReviews * 100)}%` : ''}`}
                    />
                    <span className={`vocab-word__due ${w.nextReviewAt && new Date(w.nextReviewAt).getTime() <= Date.now() ? 'vocab-word__due--now' : ''}`}>
                      {formatNextDue(w.nextReviewAt, t)}
                    </span>
                  </div>
                </div>

                {expandedId === w.id && (
                  <div className="vocab-word__detail">
                    <div className="vocab-word__detail-header">
                      <span className="vocab-word__detail-word">{w.word}</span>
                      <StageBadge stage={w.stage} t={t} />
                    </div>
                    {w.definition && (
                      <p className="vocab-word__definition">{w.definition}</p>
                    )}
                    {w.hint && (
                      <p className="vocab-word__hint">{w.hint}</p>
                    )}
                    {w.sentence && (
                      <p className="vocab-word__sentence">"{w.sentence}"</p>
                    )}
                    <div className="vocab-word__stats">
                      <span>{t('vocabulary.review.reviewed')}: {w.totalReviews}</span>
                      <span>{t('vocabulary.review.correctRate')}: {w.totalReviews > 0 ? Math.round(w.correctReviews / w.totalReviews * 100) : 0}%</span>
                      {w.nextReviewAt && (
                        <span>{t('vocabulary.dueDate')}: {new Date(w.nextReviewAt).toLocaleDateString()}</span>
                      )}
                      {w.intervalDays > 0 && (
                        <span>{t('vocabulary.interval').replace('{n}', String(w.intervalDays))}</span>
                      )}
                    </div>
                    <div className="vocab-word__actions">
                      {editingId === w.id ? (
                        <div className="vocab-word__edit-row">
                          <input
                            type="text"
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleSaveEdit(w.id)}
                            autoFocus
                          />
                          <button onClick={() => handleSaveEdit(w.id)}>{t('common.save')}</button>
                          <button onClick={() => setEditingId(null)}>{t('common.cancel')}</button>
                        </div>
                      ) : (
                        <button onClick={() => handleStartEdit(w.id, w.translation || '')}>
                          {t('vocabulary.editTranslation')}
                        </button>
                      )}
                      <button
                        className={`vocab-word__delete ${deletingId === w.id ? 'vocab-word__delete--confirming' : ''}`}
                        onClick={() => handleDelete(w.id)}
                      >
                        {deletingId === w.id ? t('vocabulary.deleteConfirmAction') : t('vocabulary.deleteConfirm')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {total > words.length && (
          <button className="vocab-load-more" onClick={loadMore}>
            {t('vocabulary.loadMore')} ({total - words.length})
          </button>
        )}
      </div>
    </div>
  )
}
