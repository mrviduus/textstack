import { useRef, useState, useCallback } from 'react'
import { useUploadSession } from '../../hooks/useUploadSession'
import { useTranslation } from '../../hooks/useTranslation'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useDragFileTracker } from '../../hooks/useDragFileTracker'
import { ACCEPT_ATTR, partitionFiles } from '../../lib/uploadFileValidation'
import { emit } from '../../lib/telemetry/myBooks'
import { UploadModal } from './UploadModal'

export function UploadDropZone() {
  const withSession = useUploadSession()
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const inputRef = useRef<HTMLInputElement>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [initialFile, setInitialFile] = useState<File | undefined>(undefined)
  const [queue, setQueue] = useState<File[]>([])

  // Highlight only — drops are handled by GlobalDropZone
  const { isDragging } = useDragFileTracker({ enabled: true, onDrop: () => {} })

  const handleBrowse = useCallback(() => {
    inputRef.current?.click()
  }, [])

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return
    const { valid } = partitionFiles(files)
    if (valid.length === 0) return
    emit('dropzone.dropped', { count: valid.length, source: 'empty_state_browse' })
    // A reader with no session gets a guest one first, as the upload button does.
    withSession(() => {
      setInitialFile(valid[0])
      setQueue(valid.slice(1))
      setModalOpen(true)
    })
  }, [withSession])

  const closeModal = useCallback(() => {
    setModalOpen(false)
    setInitialFile(undefined)
    setQueue([])
  }, [])

  return (
    <>
      <div
        className={`upload-dropzone${isDragging ? ' upload-dropzone--dragging' : ''}`}
        role="region"
        aria-label={t('library.empty.uploads.title')}
      >
        <div className="upload-dropzone__icon" aria-hidden="true">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <h2 className="upload-dropzone__title">{t('library.empty.uploads.title')}</h2>
        <p className="upload-dropzone__subtitle">{t('upload.dropzone.subtitle')}</p>
        <button
          type="button"
          className="upload-dropzone__cta"
          onClick={handleBrowse}
        >
          {t('library.empty.uploads.cta')}
        </button>
        {!isMobile && (
          <p className="upload-dropzone__shortcut">{t('library.empty.uploads.shortcut')}</p>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          onChange={(e) => { handleFiles(e.target.files); e.target.value = '' }}
          style={{ display: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
      <UploadModal open={modalOpen} onClose={closeModal} initialFile={initialFile} queue={queue} />
    </>
  )
}
