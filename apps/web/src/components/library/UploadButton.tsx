import { useState, useCallback, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useTranslation } from '../../hooks/useTranslation'
import { useGlobalUploadShortcut } from '../../hooks/useGlobalUploadShortcut'
import { useUploadSession } from '../../hooks/useUploadSession'
import { emit } from '../../lib/telemetry/myBooks'
import { UploadModal } from './UploadModal'

/**
 * The header's upload button, and the owner of the upload dialog: the tab bar's "+", the library's floating
 * button and Cmd/Ctrl+U open it through here. A reader with no session gets one first (hooks/useUploadSession),
 * so a first book needs no account.
 */
export function UploadButton() {
  const { isLoading } = useAuth()
  const withSession = useUploadSession()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const openModal = useCallback(() => {
    emit('upload_button.clicked')
    emit('upload_modal.opened')
    withSession(() => setOpen(true))
  }, [withSession])

  const closeModal = useCallback(() => setOpen(false), [])

  useGlobalUploadShortcut(!isLoading, openModal)

  useEffect(() => {
    window.addEventListener('textstack:open-upload', openModal)
    return () => window.removeEventListener('textstack:open-upload', openModal)
  }, [openModal])

  if (isLoading) return null

  // Direct-action button: clicking it opens the upload modal immediately.
  // We intentionally do NOT show a dropdown of unimplemented sources here —
  // less clicks, less to think about. URL/email/extension entry points will
  // resurface in their own flow once implemented.
  return (
    <>
      <button
        type="button"
        className="site-header__upload-btn"
        onClick={openModal}
        title={t('upload.shortcut.hint')}
        aria-label={t('upload.button')}
      >
        <span className="material-icons-outlined">add</span>
        <span className="site-header__upload-btn-label">{t('upload.button')}</span>
      </button>
      <UploadModal open={open} onClose={closeModal} />
    </>
  )
}
