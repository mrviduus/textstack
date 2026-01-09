import { useState, useEffect, FormEvent } from 'react'
import { adminApi, Site } from '../api/client'
import { AuthorAutocomplete } from '../components/AuthorAutocomplete'
import { AuthorList, AuthorItem } from '../components/AuthorList'
import { CreateAuthorModal } from '../components/CreateAuthorModal'
import { GenreSelect } from '../components/GenreSelect'

interface SelectedGenre {
  id: string
  name: string
}

export function UploadPage() {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [language, setLanguage] = useState('en')
  const [siteId, setSiteId] = useState('')
  const [sites, setSites] = useState<Site[]>([])
  const [description, setDescription] = useState('')
  const [authors, setAuthors] = useState<AuthorItem[]>([])
  const [genres, setGenres] = useState<SelectedGenre[]>([])
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)

  // Author modal state
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newAuthorName, setNewAuthorName] = useState('')

  useEffect(() => {
    adminApi.getSites().then(data => {
      setSites(data)
      if (data.length > 0) setSiteId(data[0].id)
    })
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!file) return

    // Validate required fields
    if (authors.length === 0) {
      setResult({ success: false, message: 'At least one author is required' })
      return
    }
    if (genres.length === 0) {
      setResult({ success: false, message: 'Genre is required' })
      return
    }

    setUploading(true)
    setResult(null)

    try {
      const res = await adminApi.uploadBook({
        file,
        title: title || file.name.replace(/\.[^/.]+$/, ''),
        language,
        siteId,
        description: description || undefined,
        authorIds: authors.map(a => a.id),
        genreId: genres[0].id,
      })
      setResult({ success: true, message: `Uploaded! Job ID: ${res.jobId}` })
      // Reset form
      setFile(null)
      setTitle('')
      setDescription('')
      setAuthors([])
      setGenres([])
    } catch (err) {
      setResult({ success: false, message: err instanceof Error ? err.message : 'Upload failed' })
    } finally {
      setUploading(false)
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

  return (
    <div className="upload-page">
      <h1>Upload Book</h1>
      <p className="upload-page__subtitle">Upload a book file (EPUB, FB2, PDF, TXT, DJVU) to add to the library.</p>

      <form onSubmit={handleSubmit} className="upload-form">
        <div className="form-group">
          <label htmlFor="site">Site *</label>
          <select
            id="site"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            required
          >
            {sites.map(site => (
              <option key={site.id} value={site.id}>{site.name || site.code}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="file">Book File *</label>
          <input
            type="file"
            id="file"
            accept=".epub,.fb2,.pdf,.txt,.md,.djvu"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            required
          />
          {file && <span className="file-name">{file.name}</span>}
        </div>

        <div className="form-group">
          <label htmlFor="title">Title (optional)</label>
          <input
            type="text"
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Auto-detected from file if empty"
          />
        </div>

        <div className="form-group">
          <label htmlFor="language">Language *</label>
          <select
            id="language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            required
          >
            <option value="en">English</option>
            <option value="uk">Ukrainian</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="description">Description (optional)</label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="Book description for SEO and catalog"
          />
        </div>

        {siteId && (
          <>
            <div className="form-group">
              <label>Author(s) *</label>
              <AuthorAutocomplete
                siteId={siteId}
                onSelect={handleSelectAuthor}
                onCreateNew={handleCreateNew}
                excludeIds={authors.map(a => a.id)}
                placeholder="Search or create authors..."
              />
              {authors.length > 0 && (
                <div style={{ marginTop: '12px' }}>
                  <AuthorList authors={authors} onChange={setAuthors} />
                </div>
              )}
            </div>

            <div className="form-group">
              <label>Genre *</label>
              <GenreSelect
                siteId={siteId}
                selected={genres}
                onChange={setGenres}
                maxSelections={1}
              />
            </div>
          </>
        )}

        <button
          type="submit"
          disabled={!file || uploading || authors.length === 0 || genres.length === 0}
          className="submit-btn"
        >
          {uploading ? 'Uploading...' : 'Upload Book'}
        </button>
      </form>

      {result && (
        <div className={`result ${result.success ? 'result--success' : 'result--error'}`}>
          {result.message}
        </div>
      )}

      {showCreateModal && siteId && (
        <CreateAuthorModal
          siteId={siteId}
          initialName={newAuthorName}
          onCreated={handleAuthorCreated}
          onCancel={() => { setShowCreateModal(false); setNewAuthorName('') }}
        />
      )}
    </div>
  )
}
