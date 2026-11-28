import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sheet } from '../Sheet'
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

  // Notify the rest of the app (LibraryPage, shelves, sidebar counts) that the user's books changed.
  const broadcastChange = () => emitDataChanges(['user-books', 'shelves'])

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

  return (
    <Sheet open onClose={handleClose} title={t('upload.modal.title')} className="upload-modal">
      <UploadForm
        onUploadComplete={handleUploaded}
        initialFile={currentFile}
        queueLabel={queueLabel}
      />
    </Sheet>
  )
}
