import { useState, useEffect, useCallback, useRef } from 'react'
import { platform } from '../../platform'
import { emit } from '../../lib/telemetry/myBooks'
import { pdfFilePassesSanityCheck } from '../../lib/pdfUploadSanity'
import { ACCEPT_ATTR, isUploadableFile } from '../../lib/uploadFileValidation'
import { useTranslation } from '../../hooks/useTranslation'
import { uploadErrorMessage } from '../../api/sync'

interface UploadFormProps {
  onUploadComplete: (newBookId?: string) => void
  initialFile?: File
  queueLabel?: string
}

export function UploadForm({ onUploadComplete, initialFile, queueLabel }: UploadFormProps) {
  const { t } = useTranslation()
  // A touch screen has no drag and drop: the words are the tap's.
  const touch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const lastInitialRef = useRef<File | null>(null)

  const handleUpload = useCallback(async (file: File) => {
    setError(null)

    // A drop (or the picker's "All files") skips `accept`: refuse what the reader cannot open.
    if (!isUploadableFile(file)) {
      setError(t('upload.dropzone.invalid'))
      return
    }

    // Pre-upload sanity check: a PDF picked mid-download is truncated and would
    // not open. Block before spending the upload (server also 400s it).
    if (!(await pdfFilePassesSanityCheck(file))) {
      emit('upload.failed', { reason: 'truncated_pdf_client' })
      setError(t('upload.dropzone.truncatedPdf'))
      return
    }

    setIsUploading(true)
    setUploadProgress(0)
    const startedAt = Date.now()

    try {
      const result = await platform.library.uploadUserBook(file, (percent) => {
        setUploadProgress(percent)
      })
      const newBookId = result?.userBookId
      emit('upload.completed', { durationMs: Date.now() - startedAt, sizeBytes: file.size })
      onUploadComplete(newBookId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      emit('upload.failed', { reason: msg })
      setError(uploadErrorMessage(err, t) ?? msg)
    } finally {
      setIsUploading(false)
      setUploadProgress(0)
    }
  }, [onUploadComplete, t])

  useEffect(() => {
    if (initialFile && initialFile !== lastInitialRef.current && !isUploading) {
      lastInitialRef.current = initialFile
      handleUpload(initialFile)
    }
  }, [initialFile, isUploading, handleUpload])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleUpload(file)
    e.target.value = ''
  }, [handleUpload])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleUpload(file)
  }, [handleUpload])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback(() => setIsDragging(false), [])

  return (
    <div className="upload-section">
      {queueLabel && (
        <div className="upload-section__queue" aria-live="polite">{queueLabel}</div>
      )}
      <div
        className={`upload-section__dropzone ${isDragging ? 'upload-section__dropzone--dragging' : ''} ${isUploading ? 'upload-section__dropzone--uploading' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <input
          type="file"
          accept={ACCEPT_ATTR}
          onChange={handleFileSelect}
          disabled={isUploading}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: isUploading ? 'not-allowed' : 'pointer', zIndex: 2 }}
        />

        {isUploading ? (
          <div className="upload-section__progress">
            <div className="upload-section__progress-bar">
              <div className="upload-section__progress-fill" style={{ width: `${uploadProgress}%` }} />
            </div>
            <span>{Math.round(uploadProgress)}% {t('upload.status.uploading')}</span>
          </div>
        ) : (
          <>
            <svg className="upload-section__icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p className="upload-section__text">{t(touch ? 'upload.dropzone.pick' : 'upload.dropzone.title')}</p>
            <p className="upload-section__subtext">{t(touch ? 'upload.dropzone.subtitle' : 'upload.dropzone.browse')}</p>
          </>
        )}
      </div>

      {error && <div className="upload-section__error">{error}</div>}
    </div>
  )
}
