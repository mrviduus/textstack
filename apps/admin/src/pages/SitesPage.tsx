import { useState, useEffect } from 'react'
import { adminApi, SiteListItem, ReprocessResult, ReimportResult, SyncResult, RestoreResult } from '../api/client'

export function SitesPage() {
  const [sites, setSites] = useState<SiteListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState<number>(2000)
  const [saving, setSaving] = useState(false)
  const [reprocessingSiteId, setReprocessingSiteId] = useState<string | null>(null)
  const [reprocessResult, setReprocessResult] = useState<{ siteId: string; result: ReprocessResult } | null>(null)
  const [reimportingSiteId, setReimportingSiteId] = useState<string | null>(null)
  const [reimportResult, setReimportResult] = useState<{ siteId: string; result: ReimportResult } | null>(null)
  const [syncingSiteId, setSyncingSiteId] = useState<string | null>(null)
  const [syncLimit, setSyncLimit] = useState<string>('')
  const [syncResult, setSyncResult] = useState<{ siteId: string; result: SyncResult } | null>(null)
  const [restoringSiteId, setRestoringSiteId] = useState<string | null>(null)
  const [restoreLimit, setRestoreLimit] = useState<string>('')
  const [restoreResult, setRestoreResult] = useState<{ siteId: string; result: RestoreResult } | null>(null)

  useEffect(() => {
    fetchSites()
  }, [])

  const fetchSites = async () => {
    try {
      const data = await adminApi.getSites()
      setSites(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sites')
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = (site: SiteListItem) => {
    setEditingSiteId(site.id)
    setEditValue(site.maxWordsPerPart)
  }

  const handleCancel = () => {
    setEditingSiteId(null)
  }

  const handleSave = async (siteId: string) => {
    setSaving(true)
    try {
      await adminApi.updateSite(siteId, { maxWordsPerPart: editValue })
      await fetchSites()
      setEditingSiteId(null)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleReprocess = async (siteId: string) => {
    if (!confirm('This will split long chapters into smaller parts. Continue?')) return
    setReprocessingSiteId(siteId)
    setReprocessResult(null)
    try {
      const result = await adminApi.reprocessChapters(siteId)
      setReprocessResult({ siteId, result })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to reprocess')
    } finally {
      setReprocessingSiteId(null)
    }
  }

  const handleReimport = async (siteId: string) => {
    if (!confirm('Reimport all Standard Ebooks from /data/textstack?\nThis keeps SEO metadata but replaces chapters with images.')) return
    setReimportingSiteId(siteId)
    setReimportResult(null)
    try {
      const result = await adminApi.reimportTextStack(siteId)
      setReimportResult({ siteId, result })
      await fetchSites() // refresh stats
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to reimport')
    } finally {
      setReimportingSiteId(null)
    }
  }

  const handleSync = async (siteId: string) => {
    const limit = syncLimit ? parseInt(syncLimit) : undefined
    if (!confirm(`Sync Standard Ebooks from GitHub?\n${limit ? `Limit: ${limit} books` : 'All available books'}\nThis may take a while.`)) return
    setSyncingSiteId(siteId)
    setSyncResult(null)
    try {
      const result = await adminApi.syncStandardEbooks(siteId, limit)
      setSyncResult({ siteId, result })
      await fetchSites() // refresh stats
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to sync')
    } finally {
      setSyncingSiteId(null)
    }
  }

  const handleRestore = async (siteId: string) => {
    const limit = restoreLimit ? parseInt(restoreLimit) : undefined
    if (!confirm(`Restore source files from GitHub?\nThis will download source folders for books already in DB that are missing local files.\n${limit ? `Limit: ${limit} books` : 'All missing'}\nThis may take a while.`)) return
    setRestoringSiteId(siteId)
    setRestoreResult(null)
    try {
      const result = await adminApi.restoreStandardEbooksSources(siteId, limit)
      setRestoreResult({ siteId, result })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to restore')
    } finally {
      setRestoringSiteId(null)
    }
  }

  if (loading) return <p>Loading...</p>
  if (error) return <div className="error-banner">{error}</div>

  return (
    <div className="sites-page">
      <h1>Sites</h1>
      <p className="sites-page__subtitle">Configure site-level settings</p>

      <div className="sites-list">
        {sites.map((site) => (
          <div key={site.id} className="site-card">
            <div className="site-card__header">
              <h2>{site.code}</h2>
              <span className="site-card__domain">{site.primaryDomain}</span>
            </div>

            <div className="site-card__stats">
              <div className="stat">
                <span className="stat__value">{site.workCount}</span>
                <span className="stat__label">Books</span>
              </div>
              <div className="stat">
                <span className="stat__value">{site.domainCount}</span>
                <span className="stat__label">Domains</span>
              </div>
              <div className="stat">
                <span className="stat__value">{site.defaultLanguage.toUpperCase()}</span>
                <span className="stat__label">Language</span>
              </div>
            </div>

            <div className="site-card__settings">
              <div className="setting-row">
                <label>Max Words Per Part</label>
                {editingSiteId === site.id ? (
                  <div className="setting-edit">
                    <input
                      type="number"
                      min="500"
                      max="10000"
                      step="100"
                      value={editValue}
                      onChange={(e) => setEditValue(Number(e.target.value))}
                      className="setting-input"
                    />
                    <button
                      onClick={() => handleSave(site.id)}
                      disabled={saving}
                      className="btn btn--small btn--primary"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={handleCancel}
                      disabled={saving}
                      className="btn btn--small"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="setting-display">
                    <span className="setting-value">{site.maxWordsPerPart}</span>
                    <button
                      onClick={() => handleEdit(site)}
                      className="btn btn--small"
                    >
                      Edit
                    </button>
                  </div>
                )}
                <p className="setting-hint">
                  Chapters longer than this will be split into multiple parts when reprocessed.
                </p>
              </div>

              <div className="setting-row setting-row--toggles">
                <div className="toggle-item">
                  <span className={`toggle-status ${site.adsEnabled ? 'enabled' : 'disabled'}`}>
                    {site.adsEnabled ? 'Ads Enabled' : 'Ads Disabled'}
                  </span>
                </div>
                <div className="toggle-item">
                  <span className={`toggle-status ${site.indexingEnabled ? 'enabled' : 'disabled'}`}>
                    {site.indexingEnabled ? 'Indexing Enabled' : 'Indexing Disabled'}
                  </span>
                </div>
                <div className="toggle-item">
                  <span className={`toggle-status ${site.sitemapEnabled ? 'enabled' : 'disabled'}`}>
                    {site.sitemapEnabled ? 'Sitemap Enabled' : 'Sitemap Disabled'}
                  </span>
                </div>
              </div>

              <div className="setting-row setting-row--reprocess">
                <button
                  onClick={() => handleReprocess(site.id)}
                  disabled={reprocessingSiteId === site.id}
                  className="btn btn--secondary"
                >
                  {reprocessingSiteId === site.id ? 'Reprocessing...' : 'Reprocess Chapters'}
                </button>
                <p className="setting-hint">
                  Split long chapters based on Max Words Per Part setting.
                </p>

                {reprocessResult?.siteId === site.id && (
                  <div className="reprocess-result">
                    <h4>Reprocess Complete</h4>
                    <div className="reprocess-stats">
                      <span><strong>{reprocessResult.result.editionsProcessed}</strong> editions</span>
                      <span><strong>{reprocessResult.result.chaptersSplit}</strong> chapters split</span>
                      <span><strong>{reprocessResult.result.newPartsCreated}</strong> new parts</span>
                      <span><strong>{reprocessResult.result.totalChaptersAfter}</strong> total chapters</span>
                    </div>
                    {reprocessResult.result.editions.filter(e => e.chaptersSplit > 0).length > 0 && (
                      <ul className="reprocess-editions">
                        {reprocessResult.result.editions
                          .filter(e => e.chaptersSplit > 0)
                          .map(e => (
                            <li key={e.editionId}>
                              {e.title}: {e.chaptersSplit} chapters → {e.newParts} parts
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <div className="setting-row setting-row--reprocess">
                <button
                  onClick={() => handleReimport(site.id)}
                  disabled={reimportingSiteId === site.id}
                  className="btn btn--secondary"
                >
                  {reimportingSiteId === site.id ? 'Reimporting...' : 'Reimport TextStack'}
                </button>
                <p className="setting-hint">
                  Reimport Standard Ebooks with images (keeps SEO metadata).
                </p>

                {reimportResult?.siteId === site.id && (
                  <div className="reprocess-result">
                    <h4>Reimport Complete</h4>
                    <div className="reprocess-stats">
                      <span><strong>{reimportResult.result.reimported}</strong> reimported</span>
                      <span><strong>{reimportResult.result.skipped}</strong> skipped</span>
                      <span><strong>{reimportResult.result.failed}</strong> failed</span>
                      <span><strong>{reimportResult.result.results.reduce((sum, r) => sum + r.images, 0)}</strong> images</span>
                    </div>
                    {reimportResult.result.results.filter(r => r.images > 0).length > 0 && (
                      <ul className="reprocess-editions">
                        {reimportResult.result.results
                          .filter(r => r.images > 0)
                          .map(r => (
                            <li key={r.book}>
                              {r.book}: {r.chapters} chapters, {r.images} images
                            </li>
                          ))}
                      </ul>
                    )}
                    {reimportResult.result.results.filter(r => r.error).length > 0 && (
                      <ul className="reprocess-editions" style={{ color: 'red' }}>
                        {reimportResult.result.results
                          .filter(r => r.error)
                          .map(r => (
                            <li key={r.book}>
                              {r.book}: {r.error}
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <div className="setting-row setting-row--reprocess">
                <label>Sync Standard Ebooks</label>
                <div className="setting-edit">
                  <input
                    type="number"
                    placeholder="Limit (empty = all)"
                    value={syncLimit}
                    onChange={(e) => setSyncLimit(e.target.value)}
                    className="setting-input"
                    min="1"
                    style={{ width: '120px' }}
                  />
                  <button
                    onClick={() => handleSync(site.id)}
                    disabled={syncingSiteId === site.id}
                    className="btn btn--secondary"
                  >
                    {syncingSiteId === site.id ? 'Syncing...' : 'Sync from GitHub'}
                  </button>
                </div>
                <p className="setting-hint">
                  Clone missing books from Standard Ebooks GitHub and import them.
                </p>

                {syncResult?.siteId === site.id && (
                  <div className="reprocess-result">
                    <h4>Sync Complete</h4>
                    <div className="reprocess-stats">
                      <span><strong>{syncResult.result.total}</strong> available</span>
                      <span><strong>{syncResult.result.alreadyImported}</strong> already imported</span>
                      <span><strong>{syncResult.result.cloned}</strong> cloned</span>
                      <span><strong>{syncResult.result.imported}</strong> imported</span>
                      <span><strong>{syncResult.result.failed}</strong> failed</span>
                    </div>
                    {syncResult.result.books.filter(b => b.status === 'imported').length > 0 && (
                      <ul className="reprocess-editions">
                        {syncResult.result.books
                          .filter(b => b.status === 'imported')
                          .slice(0, 20)
                          .map(b => (
                            <li key={b.identifier}>{b.identifier}</li>
                          ))}
                        {syncResult.result.books.filter(b => b.status === 'imported').length > 20 && (
                          <li>... and {syncResult.result.books.filter(b => b.status === 'imported').length - 20} more</li>
                        )}
                      </ul>
                    )}
                    {syncResult.result.books.filter(b => b.error).length > 0 && (
                      <ul className="reprocess-editions" style={{ color: 'red' }}>
                        {syncResult.result.books
                          .filter(b => b.error)
                          .map(b => (
                            <li key={b.identifier}>
                              {b.identifier}: {b.error}
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <div className="setting-row setting-row--reprocess">
                <label>Restore Source Files</label>
                <div className="setting-edit">
                  <input
                    type="number"
                    placeholder="Limit (empty = all)"
                    value={restoreLimit}
                    onChange={(e) => setRestoreLimit(e.target.value)}
                    className="setting-input"
                    min="1"
                    style={{ width: '120px' }}
                  />
                  <button
                    onClick={() => handleRestore(site.id)}
                    disabled={restoringSiteId === site.id}
                    className="btn btn--secondary"
                  >
                    {restoringSiteId === site.id ? 'Restoring...' : 'Restore from GitHub'}
                  </button>
                </div>
                <p className="setting-hint">
                  Download source folders for books in DB that don't have local files.
                </p>

                {restoreResult?.siteId === site.id && (
                  <div className="reprocess-result">
                    <h4>Restore Complete</h4>
                    <div className="reprocess-stats">
                      <span><strong>{restoreResult.result.totalInDb}</strong> in DB</span>
                      <span><strong>{restoreResult.result.alreadyHaveSource}</strong> have source</span>
                      <span><strong>{restoreResult.result.missingSource}</strong> missing</span>
                      <span><strong>{restoreResult.result.availableOnGitHub}</strong> on GitHub</span>
                      <span><strong>{restoreResult.result.restored}</strong> restored</span>
                      <span><strong>{restoreResult.result.failed}</strong> failed</span>
                    </div>
                    {restoreResult.result.books.filter(b => b.status === 'restored').length > 0 && (
                      <ul className="reprocess-editions">
                        {restoreResult.result.books
                          .filter(b => b.status === 'restored')
                          .slice(0, 20)
                          .map(b => (
                            <li key={b.identifier}>{b.identifier}</li>
                          ))}
                        {restoreResult.result.books.filter(b => b.status === 'restored').length > 20 && (
                          <li>... and {restoreResult.result.books.filter(b => b.status === 'restored').length - 20} more</li>
                        )}
                      </ul>
                    )}
                    {restoreResult.result.books.filter(b => b.error).length > 0 && (
                      <ul className="reprocess-editions" style={{ color: 'red' }}>
                        {restoreResult.result.books
                          .filter(b => b.error)
                          .map(b => (
                            <li key={b.identifier}>
                              {b.identifier}: {b.error}
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
