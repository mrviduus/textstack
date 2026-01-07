import { useState, useEffect, useRef, FormEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { adminApi, EditionDetail } from '../api/client'
import { AuthorAutocomplete } from '../components/AuthorAutocomplete'
import { AuthorList, AuthorItem } from '../components/AuthorList'
import { CreateAuthorModal } from '../components/CreateAuthorModal'
import { GenreSelect } from '../components/GenreSelect'

interface SelectedGenre {
  id: string
  name: string
}

export function EditEditionPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const coverInputRef = useRef<HTMLInputElement>(null)
  const [edition, setEdition] = useState<EditionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadingCover, setUploadingCover] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [authors, setAuthors] = useState<AuthorItem[]>([])
  const [genres, setGenres] = useState<SelectedGenre[]>([])
  const [description, setDescription] = useState('')
  // Author modal state
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newAuthorName, setNewAuthorName] = useState('')
  // SEO fields
  const [indexable, setIndexable] = useState(true)
  const [seoTitle, setSeoTitle] = useState('')
  const [seoDescription, setSeoDescription] = useState('')
  const [canonicalOverride, setCanonicalOverride] = useState('')

  useEffect(() => {
    if (!id) return
    adminApi.getEdition(id)
      .then((data) => {
        setEdition(data)
        setTitle(data.title)
        setAuthors(
          (data.authors || [])
            .sort((a, b) => a.order - b.order)
            .map(a => ({ id: a.id, name: a.name, role: a.role }))
        )
        setGenres(
          (data.genres || []).map(g => ({ id: g.id, name: g.name }))
        )
        setDescription(data.description || '')
        setIndexable(data.indexable ?? true)
        setSeoTitle(data.seoTitle || '')
        setSeoDescription(data.seoDescription || '')
        setCanonicalOverride(data.canonicalOverride || '')
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [id])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!id) return

    setSaving(true)
    setError(null)
    try {
      await adminApi.updateEdition(id, {
        title,
        description: description || null,
        indexable,
        seoTitle: seoTitle || null,
        seoDescription: seoDescription || null,
        canonicalOverride: canonicalOverride || null,
        authors: authors.map(a => ({ authorId: a.id, role: a.role })),
        genreIds: genres.map(g => g.id),
      })
      navigate('/editions')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleSelectAuthor = (author: { id: string; name: string }) => {
    setAuthors(prev => [...prev, { id: author.id, name: author.name, role: 'Author' }])
  }

  const handleCreateNew = (name: string) => {
    setNewAuthorName(name)
    setShowCreateModal(true)
  }

  const handleAuthorCreated = (author: { id: string; name: string }) => {
    setAuthors(prev => [...prev, { id: author.id, name: author.name, role: 'Author' }])
    setShowCreateModal(false)
    setNewAuthorName('')
  }

  const handlePublish = async () => {
    if (!id) return
    try {
      await adminApi.publishEdition(id)
      const updated = await adminApi.getEdition(id)
      setEdition(updated)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to publish')
    }
  }

  const handleUnpublish = async () => {
    if (!id) return
    try {
      await adminApi.unpublishEdition(id)
      const updated = await adminApi.getEdition(id)
      setEdition(updated)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to unpublish')
    }
  }

  const handleDelete = async () => {
    if (!id) return
    if (!confirm('Are you sure you want to delete this edition?')) return
    try {
      await adminApi.deleteEdition(id)
      navigate('/editions')
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !id) return

    if (file.size > 5 * 1024 * 1024) {
      alert('File too large. Max 5MB allowed')
      return
    }

    setUploadingCover(true)
    try {
      await adminApi.uploadEditionCover(id, file)
      const updated = await adminApi.getEdition(id)
      setEdition(updated)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to upload cover')
    } finally {
      setUploadingCover(false)
    }
  }

  if (loading) {
    return (
      <div className="edit-edition-page">
        <p>Loading...</p>
      </div>
    )
  }

  if (!edition) {
    return (
      <div className="edit-edition-page">
        <p className="error">Edition not found</p>
      </div>
    )
  }

  return (
    <div className="edit-edition-page">
      <div className="edit-edition-page__header">
        <h1>Edit Edition</h1>
        <span className={`badge badge--${edition.status.toLowerCase()}`}>{edition.status}</span>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <form onSubmit={handleSubmit} className="edit-form">
        <div className="form-row">
          <div className="form-group form-group--cover">
            <label>Cover</label>
            <div className="cover-upload">
              {edition.coverPath ? (
                <img
                  src={`${import.meta.env.VITE_API_URL || 'http://localhost:8080'}/storage/${edition.coverPath}`}
                  alt={edition.title}
                  className="cover-preview"
                />
              ) : (
                <div className="cover-placeholder">No cover</div>
              )}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                ref={coverInputRef}
                onChange={handleCoverUpload}
                style={{ display: 'none' }}
              />
              <button
                type="button"
                onClick={() => coverInputRef.current?.click()}
                className="btn btn--small"
                disabled={uploadingCover}
              >
                {uploadingCover ? 'Uploading...' : 'Upload Cover'}
              </button>
            </div>
          </div>

          <div className="form-group form-group--flex">
            <div className="form-group">
              <label htmlFor="title">Title *</label>
              <input
                type="text"
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={500}
              />
            </div>
          </div>
        </div>

        <div className="form-group">
          <label>Authors</label>
          <AuthorAutocomplete
            siteId={edition.siteId}
            onSelect={handleSelectAuthor}
            onCreateNew={handleCreateNew}
            excludeIds={authors.map(a => a.id)}
            placeholder="Search or create authors..."
          />
          <div style={{ marginTop: '12px' }}>
            <AuthorList authors={authors} onChange={setAuthors} />
          </div>
        </div>

        <div className="form-group">
          <label>Genres</label>
          <GenreSelect
            siteId={edition.siteId}
            selected={genres}
            onChange={setGenres}
          />
        </div>

        <div className="form-group">
          <label htmlFor="description">Description</label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            maxLength={5000}
          />
        </div>

        <fieldset className="form-fieldset">
          <legend>SEO Settings</legend>

          <div className="form-group form-group--checkbox">
            <label>
              <input
                type="checkbox"
                checked={indexable}
                onChange={(e) => setIndexable(e.target.checked)}
                disabled={edition.status === 'Draft'}
              />
              Indexable by search engines
            </label>
            {edition.status === 'Draft' && (
              <small className="form-hint">Draft editions are never indexed. Publish to enable indexing.</small>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="seoTitle">SEO Title (overrides default)</label>
            <input
              type="text"
              id="seoTitle"
              value={seoTitle}
              onChange={(e) => setSeoTitle(e.target.value)}
              placeholder={title ? `${title} — read online | TextStack` : 'Auto-generated from title'}
              maxLength={160}
            />
            <small>{seoTitle.length}/160</small>
          </div>

          <div className="form-group">
            <label htmlFor="seoDescription">SEO Description</label>
            <textarea
              id="seoDescription"
              value={seoDescription}
              onChange={(e) => setSeoDescription(e.target.value)}
              rows={3}
              placeholder="Auto-generated from book description"
              maxLength={320}
            />
            <small>{seoDescription.length}/320</small>
          </div>

          <div className="form-group">
            <label htmlFor="canonicalOverride">Canonical URL Override</label>
            <input
              type="url"
              id="canonicalOverride"
              value={canonicalOverride}
              onChange={(e) => setCanonicalOverride(e.target.value)}
              placeholder="Leave empty for default"
            />
          </div>
        </fieldset>

        <div className="form-actions">
          <button type="submit" disabled={saving} className="btn btn--primary">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button type="button" onClick={() => navigate('/editions')} className="btn">
            Cancel
          </button>
        </div>
      </form>

      <div className="edition-info">
        <h2>Details</h2>
        <dl>
          <dt>Slug</dt>
          <dd>{edition.slug}</dd>
          <dt>Language</dt>
          <dd>{edition.language}</dd>
          <dt>Created</dt>
          <dd>{new Date(edition.createdAt).toLocaleString()}</dd>
          {edition.publishedAt && (
            <>
              <dt>Published</dt>
              <dd>{new Date(edition.publishedAt).toLocaleString()}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="edition-chapters">
        <h2>Chapters ({edition.chapters.length})</h2>
        {edition.chapters.length === 0 ? (
          <p>No chapters yet.</p>
        ) : (
          <table className="chapters-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Title</th>
                <th>Words</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {edition.chapters.map((ch) => (
                <tr key={ch.id}>
                  <td>{ch.chapterNumber}</td>
                  <td>{ch.title}</td>
                  <td>{ch.wordCount ?? '-'}</td>
                  <td>
                    <Link to={`/chapters/${ch.id}`} className="btn btn--small">
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="edition-actions">
        <h2>Actions</h2>
        <div className="action-buttons">
          {edition.status === 'Draft' && (
            <button onClick={handlePublish} className="btn btn--success">
              Publish Edition
            </button>
          )}
          {edition.status === 'Published' && (
            <button onClick={handleUnpublish} className="btn btn--warning">
              Unpublish Edition
            </button>
          )}
          {edition.status !== 'Published' && (
            <button onClick={handleDelete} className="btn btn--danger">
              Delete Edition
            </button>
          )}
        </div>
      </div>

      {showCreateModal && (
        <CreateAuthorModal
          siteId={edition.siteId}
          initialName={newAuthorName}
          onCreated={handleAuthorCreated}
          onCancel={() => { setShowCreateModal(false); setNewAuthorName('') }}
        />
      )}
    </div>
  )
}
