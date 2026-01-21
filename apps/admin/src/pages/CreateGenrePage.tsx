import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { adminApi, DEFAULT_SITE_ID } from '../api/client'

export function CreateGenrePage() {
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [indexable, setIndexable] = useState(true)
  const [seoTitle, setSeoTitle] = useState('')
  const [seoDescription, setSeoDescription] = useState('')

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Name is required')
      return
    }

    setSaving(true)
    setError(null)

    try {
      // 1. Create genre with name
      const result = await adminApi.createGenre(DEFAULT_SITE_ID, name.trim())
      const genreId = result.id

      // 2. Update with full data
      await adminApi.updateGenre(genreId, {
        name: name.trim(),
        description: description || null,
        indexable,
        seoTitle: seoTitle || null,
        seoDescription: seoDescription || null,
      })

      // 3. Redirect to edit page
      navigate(`/genres/${genreId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create genre')
      setSaving(false)
    }
  }

  return (
    <div className="edit-genre-page">
      <div className="edit-genre-page__header">
        <Link to="/genres" className="back-link">&larr; Back to Genres</Link>
        <h1>New Genre</h1>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <form onSubmit={handleSave} className="edit-author-form">
        <div className="form-section">
          <h2>Basic Info</h2>

          <div className="form-group">
            <label htmlFor="name">Name *</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="description">Description</label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Genre description..."
            />
          </div>
        </div>

        <div className="form-section">
          <h2>SEO</h2>

          <div className="form-group form-group--checkbox">
            <label>
              <input
                type="checkbox"
                checked={indexable}
                onChange={(e) => setIndexable(e.target.checked)}
              />
              Allow search engines to index this page
            </label>
          </div>

          <div className="form-group">
            <label htmlFor="seoTitle">SEO Title</label>
            <input
              id="seoTitle"
              type="text"
              value={seoTitle}
              onChange={(e) => setSeoTitle(e.target.value)}
              placeholder="Custom page title for search engines"
            />
          </div>

          <div className="form-group">
            <label htmlFor="seoDescription">SEO Description</label>
            <textarea
              id="seoDescription"
              value={seoDescription}
              onChange={(e) => setSeoDescription(e.target.value)}
              rows={3}
              placeholder="Meta description for search engines"
            />
          </div>
        </div>

        <div className="form-actions">
          <Link to="/genres" className="btn">Cancel</Link>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? 'Creating...' : 'Create Genre'}
          </button>
        </div>
      </form>
    </div>
  )
}
