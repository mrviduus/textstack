import { useState, useEffect, useCallback, useRef } from 'react'
import { uploadUserBook, getStorageQuota, type StorageQuota } from '../../api/userBooks'
import { emit } from '../../lib/telemetry/myBooksV2'
import { pdfFilePassesSanityCheck } from '../../lib/pdfUploadSanity'
import { useTranslation } from '../../hooks/useTranslation'
import { v2UploadMessage } from '../../api/v2'

interface UploadFormProps {
  onUploadComplete: (newBookId?: string, hasOriginalPdf?: boolean) => void
  initialFile?: File
  queueLabel?: string
}

export function UploadForm({ onUploadComplete, initialFile, queueLabel }: UploadFormProps) {
  const { t } = useTranslation()
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [quota, setQuota] = useState<StorageQuota | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const lastInitialRef = useRef<File | null>(null)

  useEffect(() => {
    getStorageQuota().then(setQuota).catch(() => {})
  }, [])

  const handleUpload = useCallback(async (file: File) => {
    setError(null)

    // Pre-upload sanity check: a PDF picked mid-download is truncated and would
    // fail ingestion. Block before spending the upload (server also 400s it).
    if (!(await pdfFilePassesSanityCheck(file))) {
      emit('upload.failed', { reason: 'truncated_pdf_client' })
      setError(t('upload.dropzone.truncatedPdf'))
      return
    }

    setIsUploading(true)
    setUploadProgress(0)
    const startedAt = Date.now()

    try {
      const result = await uploadUserBook(file, undefined, undefined, (percent) => {
        setUploadProgress(percent)
      })
      const newBookId = result?.userBookId
      emit('upload.completed', { durationMs: Date.now() - startedAt, sizeBytes: file.size })
      onUploadComplete(newBookId, result?.hasOriginalPdf)
      getStorageQuota().then(setQuota).catch(() => {})
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      emit('upload.failed', { reason: msg })
      setError(v2UploadMessage(err, t) ?? msg)
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

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
  }

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
          accept=".epub,.pdf"
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
            <p className="upload-section__text">{t('upload.dropzone.title')}</p>
            <p className="upload-section__subtext">{t('upload.dropzone.browse')}</p>
          </>
        )}
      </div>

      {error && <div className="upload-section__error">{error}</div>}

      {quota && (
        <div className="upload-section__quota">
          <div className="upload-section__quota-bar">
            <div className="upload-section__quota-fill" style={{ width: `${Math.min(quota.usedPercent, 100)}%` }} />
          </div>
          <span className="upload-section__quota-text">
            {formatBytes(quota.usedBytes)} / {formatBytes(quota.limitBytes)} used
          </span>
        </div>
      )}
    </div>
  )
}
