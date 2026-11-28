import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../../context/AuthContext'
import { useUploadSession } from '../../hooks/useUploadSession'
import { useTranslation } from '../../hooks/useTranslation'
import { useDragFileTracker } from '../../hooks/useDragFileTracker'
import { partitionFiles } from '../../lib/uploadFileValidation'
import { emit } from '../../lib/telemetry/myBooks'
import { Toast } from '../Toast'
import { UploadModal } from './UploadModal'

type ToastState = { kind: 'invalid'; key: number } | null

export function GlobalDropZone() {
  const { isLoading } = useAuth()
  const withSession = useUploadSession()
  const { t } = useTranslation()
  const [modalOpen, setModalOpen] = useState(false)
  const [initialFile, setInitialFile] = useState<File | undefined>(undefined)
  const [queue, setQueue] = useState<File[]>([])
  const [toast, setToast] = useState<ToastState>(null)

  const handleDrop = useCallback((files: File[]) => {
    emit('dropzone.dropped', { count: files.length })
    const { valid, invalid } = partitionFiles(files)
    if (invalid.length > 0 && valid.length === 0) {
      emit('dropzone.invalid_file', { reason: 'extension', count: invalid.length })
      setToast({ kind: 'invalid', key: Date.now() })
      return
    }
    if (valid.length === 0) return
    // A reader with no session gets a guest one first, as the upload button does.
    withSession(() => {
      setInitialFile(valid[0])
      setQueue(valid.slice(1))
      setModalOpen(true)
    })
  }, [withSession])

  const { isDragging } = useDragFileTracker({
    enabled: !modalOpen && !isLoading,
    onDrop: handleDrop,
  })

  useEffect(() => {
    if (isDragging) emit('dropzone.activated')
  }, [isDragging])

  const closeModal = useCallback(() => {
    setModalOpen(false)
    setInitialFile(undefined)
    setQueue([])
  }, [])

  const dismissToast = useCallback(() => setToast(null), [])

  return (
    <>
      {isDragging && createPortal(
        <div className="dropzone-overlay" role="presentation" aria-hidden="true">
          <div className="dropzone-overlay__box">
            <div className="dropzone-overlay__icon" aria-hidden="true">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <div className="dropzone-overlay__title">{t('upload.dropzone.title')}</div>
            <div className="dropzone-overlay__subtitle">{t('upload.dropzone.subtitle')}</div>
          </div>
        </div>,
        document.body,
      )}
      <UploadModal open={modalOpen} onClose={closeModal} initialFile={initialFile} queue={queue} />
      {toast?.kind === 'invalid' && (
        <Toast key={toast.key} message={t('upload.dropzone.invalid')} duration={3500} onClose={dismissToast} />
      )}
    </>
  )
}
