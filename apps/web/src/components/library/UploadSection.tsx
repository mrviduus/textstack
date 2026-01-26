import { useState, useEffect, useRef, useCallback } from 'react'
import { uploadUserBook, getStorageQuota, type StorageQuota } from '../../api/userBooks'

interface UploadSectionProps {
  onUploadComplete: () => void
}

export function UploadSection({ onUploadComplete }: UploadSectionProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [quota, setQuota] = useState<StorageQuota | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Fetch quota on mount
  useEffect(() => {
    getStorageQuota()
      .then(setQuota)
      .catch(() => {})
  }, [])

  const handleUpload = useCallback(async (file: File) => {
    setError(null)
    setIsUploading(true)
    setUploadProgress(0)

    try {
      await uploadUserBook(file, undefined, undefined, (percent) => {
        setUploadProgress(percent)
      })
      onUploadComplete()
      // Refresh quota after upload
      getStorageQuota().then(setQuota).catch(() => {})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setIsUploading(false)
      setUploadProgress(0)
    }
  }, [onUploadComplete])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      handleUpload(file)
    }
    // Reset input so same file can be selected again
    e.target.value = ''
  }, [handleUpload])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) {
      handleUpload(file)
    }
  }, [handleUpload])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setIsDragging(false)
  }, [])

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
  }

  return (
    <div className="upload-section">
      <div
        className={`upload-section__dropzone ${isDragging ? 'upload-section__dropzone--dragging' : ''} ${isUploading ? 'upload-section__dropzone--uploading' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !isUploading && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".epub"
          onChange={handleFileSelect}
          disabled={isUploading}
          hidden
        />

        {isUploading ? (
          <div className="upload-section__progress">
            <div className="upload-section__progress-bar">
              <div
                className="upload-section__progress-fill"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <span>{Math.round(uploadProgress)}% uploading...</span>
          </div>
        ) : (
          <>
            <svg className="upload-section__icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p className="upload-section__text">
              Drop EPUB here
            </p>
            <p className="upload-section__subtext">
              or click to browse
            </p>
          </>
        )}
      </div>

      {error && (
        <div className="upload-section__error">
          {error}
        </div>
      )}

      {quota && (
        <div className="upload-section__quota">
          <div className="upload-section__quota-bar">
            <div
              className="upload-section__quota-fill"
              style={{ width: `${Math.min(quota.usedPercent, 100)}%` }}
            />
          </div>
          <span className="upload-section__quota-text">
            {formatBytes(quota.usedBytes)} / {formatBytes(quota.limitBytes)} used
          </span>
        </div>
      )}
    </div>
  )
}
