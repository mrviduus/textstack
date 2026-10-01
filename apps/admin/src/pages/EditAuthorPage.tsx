import { useState, useEffect, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { adminApi, AuthorDetail } from '../api/client'
import { SeoContentFieldset } from '../components/SeoContentFieldset'
import { parseSeoThemes } from '@textstack/shared/lib/seoThemes'

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
  // External authority links (schema.org sameAs)
  const [linkWikipedia, setLinkWikipedia] = useState('')
  const [linkGoodreads, setLinkGoodreads] = useState('')
  const [linkGutenberg, setLinkGutenberg] = useState('')
  const [linkWebsite, setLinkWebsite] = useState('')
  const [linkTwitter, setLinkTwitter] = useState('')

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
        setSeoThemes(parseSeoThemes(data.seoThemesJson))
        setSeoFaqs(data.seoFaqsJson ? JSON.parse(data.seoFaqsJson) : [])
        if (data.externalLinksJson) {
          try {
            const links = JSON.parse(data.externalLinksJson) as Record<string, string | undefined>
            setLinkWikipedia(links.wikipedia || '')
            setLinkGoodreads(links.goodreads || '')
            setLinkGutenberg(links.gutenberg || '')
            setLinkWebsite(links.website || '')
            setLinkTwitter(links.twitter || '')
          } catch {
            // ignore malformed
          }
        }
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
      const externalLinks: Record<string, string> = {}
      if (linkWikipedia.trim()) externalLinks.wikipedia = linkWikipedia.trim()
      if (linkGoodreads.trim()) externalLinks.goodreads = linkGoodreads.trim()
      if (linkGutenberg.trim()) externalLinks.gutenberg = linkGutenberg.trim()
      if (linkWebsite.trim()) externalLinks.website = linkWebsite.trim()
      if (linkTwitter.trim()) externalLinks.twitter = linkTwitter.trim()
      const externalLinksJson = Object.keys(externalLinks).length > 0
        ? JSON.stringify(externalLinks)
        : null
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
        externalLinksJson,
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

  const handlePublishBook = async (editionId: string) => {
    try {
      await adminApi.publishEdition(editionId)
      const updated = await adminApi.getAuthor(id!)
      setAuthor(updated)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to publish')
    }
  }

  const handleUnpublishBook = async (editionId: string) => {
    try {
      await adminApi.unpublishEdition(editionId)
      const updated = await adminApi.getAuthor(id!)
      setAuthor(updated)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to unpublish')
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

        <div className="form-section">
          <h2>External Links</h2>
          <p className="text-muted" style={{ marginTop: 0 }}>
            Authority links for schema.org <code>sameAs</code>. Leave empty fields blank.
          </p>

          <div className="form-group">
            <label htmlFor="linkWikipedia">Wikipedia URL</label>
            <input
              id="linkWikipedia"
              type="url"
              value={linkWikipedia}
              onChange={(e) => setLinkWikipedia(e.target.value)}
              placeholder="https://en.wikipedia.org/wiki/..."
            />
          </div>

          <div className="form-group">
            <label htmlFor="linkGoodreads">Goodreads URL</label>
            <input
              id="linkGoodreads"
              type="url"
              value={linkGoodreads}
              onChange={(e) => setLinkGoodreads(e.target.value)}
              placeholder="https://www.goodreads.com/author/show/..."
            />
          </div>

          <div className="form-group">
            <label htmlFor="linkGutenberg">Project Gutenberg URL</label>
            <input
              id="linkGutenberg"
              type="url"
              value={linkGutenberg}
              onChange={(e) => setLinkGutenberg(e.target.value)}
              placeholder="https://www.gutenberg.org/ebooks/author/..."
            />
          </div>

          <div className="form-group">
            <label htmlFor="linkWebsite">Official Website</label>
            <input
              id="linkWebsite"
              type="url"
              value={linkWebsite}
              onChange={(e) => setLinkWebsite(e.target.value)}
              placeholder="https://..."
            />
          </div>

          <div className="form-group">
            <label htmlFor="linkTwitter">Twitter / X URL</label>
            <input
              id="linkTwitter"
              type="url"
              value={linkTwitter}
              onChange={(e) => setLinkTwitter(e.target.value)}
              placeholder="https://twitter.com/..."
            />
          </div>
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
                <th>Actions</th>
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
                  <td className="actions-cell">
                    {book.status === 'Draft' && (
                      <button
                        type="button"
                        onClick={() => handlePublishBook(book.editionId)}
                        className="btn btn--small btn--success"
                      >
                        Publish
                      </button>
                    )}
                    {book.status === 'Published' && (
                      <button
                        type="button"
                        onClick={() => handleUnpublishBook(book.editionId)}
                        className="btn btn--small btn--warning"
                      >
                        Unpublish
                      </button>
                    )}
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
