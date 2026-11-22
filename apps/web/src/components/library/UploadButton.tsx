import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useLanguage } from '../../context/LanguageContext'
import { useTranslation } from '../../hooks/useTranslation'
import { useGlobalUploadShortcut } from '../../hooks/useGlobalUploadShortcut'
import { emit } from '../../lib/telemetry/myBooks'
import { UploadModal } from './UploadModal'

export function UploadButton() {
  const { isAuthenticated, isLoading } = useAuth()
  const { getLocalizedPath } = useLanguage()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const openModal = useCallback(() => {
    emit('upload_button.clicked')
    emit('upload_modal.opened')
    setOpen(true)
  }, [])

  const closeModal = useCallback(() => setOpen(false), [])

  useGlobalUploadShortcut(isAuthenticated, openModal)

  useEffect(() => {
    if (!isAuthenticated) return
    const handler = () => openModal()
    window.addEventListener('textstack:open-upload', handler)
    return () => window.removeEventListener('textstack:open-upload', handler)
  }, [isAuthenticated, openModal])

  if (isLoading) return null

  if (!isAuthenticated) {
    return (
      <button
        className="site-header__upload-btn site-header__upload-btn--signin"
        onClick={() => navigate(getLocalizedPath('/login?next=/library'))}
        title={t('upload.modal.signin')}
        aria-label={t('upload.modal.signin')}
        type="button"
      >
        <span className="material-icons-outlined">upload</span>
        <span className="site-header__upload-btn-label">{t('upload.modal.signin')}</span>
      </button>
    )
  }

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
