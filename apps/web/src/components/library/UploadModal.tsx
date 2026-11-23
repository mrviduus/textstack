import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useLanguage } from '../../context/LanguageContext'
import { useTranslation } from '../../hooks/useTranslation'
import { UploadForm } from './UploadForm'
import { emitDataChanges } from '../../lib/dataEvents'

interface UploadModalProps {
  open: boolean
  onClose: () => void
  initialFile?: File
  queue?: File[]
}

export function UploadModal({ open, onClose, initialFile, queue }: UploadModalProps) {
  const containerRef = useFocusTrap(open)
  const navigate = useNavigate()
  const { getLocalizedPath } = useLanguage()
  const { t } = useTranslation()
  const [currentFile, setCurrentFile] = useState<File | undefined>(initialFile)
  const [pendingQueue, setPendingQueue] = useState<File[]>(queue ?? [])
  const totalRef = useRef<number>(0)
  const processedRef = useRef<number>(0)

  // Reset state when modal opens.
  useEffect(() => {
    if (!open) return
    setCurrentFile(initialFile)
    setPendingQueue(queue ?? [])
    totalRef.current = (initialFile ? 1 : 0) + (queue?.length ?? 0)
    processedRef.current = 0
  }, [open, initialFile, queue])

  // Lock body scroll while modal is open. Pattern from Search/ImageLightbox.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Notify the rest of the app (LibraryPage, shelves, sidebar counts) that the user's books changed.
  const broadcastChange = () => emitDataChanges(['user-books', 'shelves'])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  // File uploaded. If queue: kick the next file into the form. Otherwise the book is readable now
  // (the reader parses its file, ADR-033): drop straight into it.
  const handleUploaded = (newBookId?: string) => {
    processedRef.current += 1

    if (pendingQueue.length > 0) {
      const [next, ...rest] = pendingQueue
      setCurrentFile(next)
      setPendingQueue(rest)
      return
    }

    broadcastChange()
    onClose()
    navigate(getLocalizedPath(newBookId ? `/library/my/${newBookId}/read` : '/library'))
  }

  const handleClose = () => {
    broadcastChange()
    onClose()
  }

  const queueLabel = totalRef.current > 1 && pendingQueue.length > 0
    ? `${processedRef.current + 1} of ${totalRef.current} — next: ${pendingQueue[0]?.name ?? ''}`
    : undefined

  return createPortal(
    <div className="upload-modal__overlay" onClick={handleClose} role="presentation">
      <div
        ref={containerRef}
        className="upload-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-modal-title"
      >
        <button
          className="upload-modal__close"
          onClick={handleClose}
          aria-label={t('common.close')}
          type="button"
        >
          &times;
        </button>
        <h2 id="upload-modal-title" className="upload-modal__title">{t('upload.modal.title')}</h2>

        <UploadForm
          onUploadComplete={handleUploaded}
          initialFile={currentFile}
          queueLabel={queueLabel}
        />
      </div>
    </div>,
    document.body,
  )
}
