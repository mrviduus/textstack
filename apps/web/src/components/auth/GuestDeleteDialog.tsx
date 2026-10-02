import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../../context/AuthContext'
import { useTranslation } from '../../hooks/useTranslation'

/**
 * "Delete guest data?" — the guest's only way out. A guest has no credentials, so signing out
 * would orphan the row; this deletes it server-side (DELETE /me/account) instead. Best-effort:
 * if the delete fails (offline, 5xx) the session is still dropped locally via logout.
 */
export function GuestDeleteDialog({ onClose }: { onClose: () => void }) {
  const { deleteAccount, logout } = useAuth()
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)

  const handleDelete = async () => {
    setLoading(true)
    try {
      await deleteAccount() // clears the session on success
    } catch {
      await logout()
    }
    onClose()
  }

  return createPortal(
    <div className="profile-overlay" onClick={loading ? undefined : onClose}>
      <div
        className="profile-modal profile-modal--danger"
        onClick={e => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="guest-delete-title"
        aria-describedby="guest-delete-message"
      >
        <div className="profile-modal__body">
          <h2 className="profile-modal__title" id="guest-delete-title">{t('guest.deleteTitle')}</h2>
          <p className="profile-modal__danger-warning" id="guest-delete-message">{t('guest.deleteMessage')}</p>
          <div className="profile-modal__danger-actions">
            <button
              type="button"
              className="profile-modal__btn profile-modal__btn--secondary"
              onClick={onClose}
              disabled={loading}
              autoFocus
            >
              {t('guest.deleteCancel')}
            </button>
            <button
              type="button"
              className="profile-modal__btn profile-modal__btn--danger"
              onClick={handleDelete}
              disabled={loading}
            >
              {t('guest.deleteConfirm')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
