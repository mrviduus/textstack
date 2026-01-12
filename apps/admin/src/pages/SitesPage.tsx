import { useState, useEffect } from 'react'
import { adminApi, SiteListItem, ReprocessResult } from '../api/client'

export function SitesPage() {
  const [sites, setSites] = useState<SiteListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState<number>(2000)
  const [saving, setSaving] = useState(false)
  const [reprocessingSiteId, setReprocessingSiteId] = useState<string | null>(null)
  const [reprocessResult, setReprocessResult] = useState<{ siteId: string; result: ReprocessResult } | null>(null)

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
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
