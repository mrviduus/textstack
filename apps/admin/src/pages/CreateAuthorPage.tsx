import { useState, useRef, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { adminApi, DEFAULT_SITE_ID } from '../api/client'

export function CreateAuthorPage() {
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)

  // Form state
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  const [indexable, setIndexable] = useState(true)
  const [seoTitle, setSeoTitle] = useState('')
  const [seoDescription, setSeoDescription] = useState('')

  // Cleanup blob URL on unmount or when preview changes
  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview)
    }
  }, [photoPreview])

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > 2 * 1024 * 1024) {
      alert('File too large. Max 2MB allowed')
      return
    }

    // Revoke old URL before creating new one
    if (photoPreview) URL.revokeObjectURL(photoPreview)

    setPhotoFile(file)
    setPhotoPreview(URL.createObjectURL(file))
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Name is required')
      return
    }

    setSaving(true)
    setError(null)

    try {
      // 1. Create author with name
      const result = await adminApi.createAuthor(DEFAULT_SITE_ID, name.trim())
      const authorId = result.id

      // 2. Upload photo if selected
      if (photoFile) {
        await adminApi.uploadAuthorPhoto(authorId, photoFile)
      }

      // 3. Update with full data
      await adminApi.updateAuthor(authorId, {
        name: name.trim(),
        bio: bio || null,
        indexable,
        seoTitle: seoTitle || null,
        seoDescription: seoDescription || null,
      })

      // 4. Redirect to edit page
      navigate(`/authors/${authorId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create author')
      setSaving(false)
    }
  }

  return (
    <div className="edit-author-page">
      <div className="edit-author-page__header">
        <Link to="/authors" className="back-link">&larr; Back to Authors</Link>
        <h1>New Author</h1>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <form onSubmit={handleSave} className="edit-author-form">
        <div className="form-section">
          <h2>Basic Info</h2>

          <div className="form-row">
            <div className="form-group form-group--photo">
              <label>Photo</label>
              <div className="photo-upload">
                {photoPreview ? (
                  <img src={photoPreview} alt="Preview" className="photo-preview" />
                ) : (
                  <div className="photo-placeholder">No photo</div>
                )}
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  ref={fileInputRef}
                  onChange={handlePhotoSelect}
                  style={{ display: 'none' }}
                />
                <button type="button" onClick={() => fileInputRef.current?.click()} className="btn btn--small">
                  Select Photo
                </button>
              </div>
            </div>

            <div className="form-group form-group--flex">
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
        </div>

        <div className="form-actions">
          <Link to="/authors" className="btn">Cancel</Link>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? 'Creating...' : 'Create Author'}
          </button>
        </div>
      </form>
    </div>
  )
}
