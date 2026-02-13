import { useState, useEffect, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { adminApi, AuthorDetail } from '../api/client'
import { SeoContentFieldset } from '../components/SeoContentFieldset'

interface FAQItem {
  question: string
  answer: string
}

export function EditAuthorPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [author, setAuthor] = useState<AuthorDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [photoCacheBust, setPhotoCacheBust] = useState(Date.now())

  // Form state
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  const [indexable, setIndexable] = useState(true)
  const [seoTitle, setSeoTitle] = useState('')
  const [seoDescription, setSeoDescription] = useState('')
  const [canonicalOverride, setCanonicalOverride] = useState('')
  // SEO content blocks
  const [seoRelevanceText, setSeoRelevanceText] = useState('')
  const [seoThemes, setSeoThemes] = useState<string[]>([])
  const [seoFaqs, setSeoFaqs] = useState<FAQItem[]>([])

  useEffect(() => {
    if (!id) return
    const fetchAuthor = async () => {
      try {
        const data = await adminApi.getAuthor(id)
        setAuthor(data)
        setName(data.name)
        setBio(data.bio || '')
        setIndexable(data.indexable)
        setSeoTitle(data.seoTitle || '')
        setSeoDescription(data.seoDescription || '')
        setCanonicalOverride(data.canonicalOverride || '')
        setSeoRelevanceText(data.seoRelevanceText || '')
        setSeoThemes(data.seoThemesJson ? JSON.parse(data.seoThemesJson) : [])
        setSeoFaqs(data.seoFaqsJson ? JSON.parse(data.seoFaqsJson) : [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load author')
      } finally {
        setLoading(false)
      }
    }
    fetchAuthor()
  }, [id])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return
    setSaving(true)
    try {
      await adminApi.updateAuthor(id, {
        name,
        bio: bio || null,
        indexable,
        seoTitle: seoTitle || null,
        seoDescription: seoDescription || null,
        canonicalOverride: canonicalOverride || null,
        seoRelevanceText: seoRelevanceText || null,
        seoThemesJson: seoThemes.length > 0 ? JSON.stringify(seoThemes) : null,
        seoFaqsJson: seoFaqs.length > 0 ? JSON.stringify(seoFaqs) : null,
      })
      const updated = await adminApi.getAuthor(id)
      setAuthor(updated)
      alert('Author saved!')
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !id) return

    if (file.size > 2 * 1024 * 1024) {
      alert('File too large. Max 2MB allowed')
      return
    }

    try {
      await adminApi.uploadAuthorPhoto(id, file)
      const updated = await adminApi.getAuthor(id)
      setAuthor(updated)
      setPhotoCacheBust(Date.now())
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to upload photo')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDeletePhoto = async () => {
    if (!id || !author?.photoPath) return
    if (!confirm('Remove photo?')) return
    try {
      await adminApi.deleteAuthorPhoto(id)
      const updated = await adminApi.getAuthor(id)
      setAuthor(updated)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete photo')
    }
  }

  const handleDelete = async () => {
    if (!id || !author) return
    if (author.bookCount > 0) {
      alert('Cannot delete author with books')
      return
    }
    if (!confirm(`Are you sure you want to delete "${author.name}"?`)) return
    try {
      await adminApi.deleteAuthor(id)
      navigate('/authors')
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  if (loading) return <p>Loading...</p>
  if (error) return <div className="error-banner">{error}</div>
  if (!author) return <p>Author not found</p>

  return (
    <div className="edit-author-page">
      <div className="edit-author-page__header">
        <Link to="/authors" className="back-link">&larr; Back to Authors</Link>
        <h1>{author.name}</h1>
      </div>

      <form onSubmit={handleSave} className="edit-author-form">
        <div className="form-section">
          <h2>Basic Info</h2>

          <div className="form-row">
            <div className="form-group form-group--photo">
              <label>Photo</label>
              <div className="photo-upload">
                {author.photoPath ? (
                  <img
                    src={`${import.meta.env.VITE_API_URL || 'http://localhost:8080'}/storage/${author.photoPath}?v=${photoCacheBust}`}
                    alt={author.name}
                    className="photo-preview"
                  />
                ) : (
                  <div className="photo-placeholder">No photo</div>
                )}
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  ref={fileInputRef}
                  onChange={handlePhotoUpload}
                  style={{ display: 'none' }}
                />
                <div className="photo-actions">
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="btn btn--small">
                    Upload Photo
                  </button>
                  {author.photoPath && (
                    <button type="button" onClick={handleDeletePhoto} className="btn btn--small btn--danger">
                      Remove Photo
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="form-group form-group--flex">
              <div className="form-group">
                <label htmlFor="name">Name</label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="bio">Bio</label>
                <textarea
                  id="bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={5}
                  placeholder="Short bio or notable quote..."
                />
              </div>
            </div>
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

          <div className="form-group">
            <label htmlFor="canonicalOverride">Canonical URL Override</label>
            <input
              id="canonicalOverride"
              type="text"
              value={canonicalOverride}
              onChange={(e) => setCanonicalOverride(e.target.value)}
              placeholder="Leave empty for default canonical"
            />
          </div>

          <SeoContentFieldset
            relevanceText={seoRelevanceText}
            onRelevanceTextChange={setSeoRelevanceText}
            themes={seoThemes}
            onThemesChange={setSeoThemes}
            faqs={seoFaqs}
            onFaqsChange={setSeoFaqs}
          />
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>

      {author.books.length > 0 && (
        <div className="form-section">
          <h2>Books ({author.bookCount})</h2>
          <table className="books-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Role</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {author.books.map((book) => (
                <tr key={book.editionId}>
                  <td>
                    <Link to={`/editions/${book.editionId}`}>{book.title}</Link>
                  </td>
                  <td>{book.role}</td>
                  <td>
                    <span className={`badge badge--${book.status.toLowerCase()}`}>
                      {book.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="form-section form-section--danger">
        <h2>Danger Zone</h2>
        <p>Deleting an author is permanent and cannot be undone.</p>
        <button
          type="button"
          onClick={handleDelete}
          className="btn btn--danger"
          disabled={author.bookCount > 0}
        >
          Delete Author
        </button>
        {author.bookCount > 0 && (
          <p className="text-muted">Remove author from all books before deleting.</p>
        )}
      </div>
    </div>
  )
}
