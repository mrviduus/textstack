import { useState, useRef, FormEvent, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../../context/AuthContext'
import { POPULAR_LANGUAGES, getLanguage } from '@textstack/shared'
import { getFlagUrl } from '../../data/flags'
import { getAnonymousReader } from '@textstack/shared'
import { getUserInitials } from '../../lib/userInitials'
import { useTranslation } from '../../hooks/useTranslation'
import { DeleteAccountDialog } from './DeleteAccountDialog'

export function ProfileModal({ onClose }: { onClose: () => void }) {
  const { user, updateProfile, updateAvatar, deleteAvatar } = useAuth()
  const { t } = useTranslation()
  const [showDeleteAccount, setShowDeleteAccount] = useState(false)
  const [name, setName] = useState(user?.name || '')
  const [nativeLanguage, setNativeLanguage] = useState(user?.nativeLanguage || '')
  const [preview, setPreview] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [anonImgFailed, setAnonImgFailed] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setAnonImgFailed(false) }, [user?.id])

  if (!user) return null

  const avatarSrc = preview || (user.picture?.startsWith('http')
    ? user.picture
    : user.picture ? `/storage/${user.picture}` : null)

  const isGuest = !!user.isGuest
  const anon = isGuest ? getAnonymousReader(user.id) : null
  const initials = getUserInitials(user)
  const hasUserAvatar = !!(avatarSrc && avatarSrc !== '__remove__')
  const showAnimal = !hasUserAvatar && !!anon?.avatarPath && !anonImgFailed

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setPreview(URL.createObjectURL(f))
  }

  const handleRemoveAvatar = () => {
    setFile(null)
    setPreview('__remove__')
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const trimmedName = name.trim() || null
      const nextLang = nativeLanguage.trim()
      const nameChanged = (trimmedName ?? '') !== (user.name ?? '')
      const langChanged = nextLang !== (user.nativeLanguage ?? '')
      if (nameChanged || langChanged) {
        await updateProfile({
          ...(nameChanged ? { name: trimmedName } : {}),
          ...(langChanged ? { nativeLanguage: nextLang } : {}),
        })
      }
      if (file) {
        await updateAvatar(file)
      } else if (preview === '__remove__' && user.picture) {
        await deleteAvatar()
      }
      onClose()
    } catch (err: any) {
      setError(err.message || 'Failed to update profile.')
    } finally {
      setLoading(false)
    }
  }

  // Portal escapes header's backdrop-filter containing block — otherwise
  // `position: fixed; inset: 0` scopes to the 80px header, not the viewport.
  return createPortal(
    <div className="profile-overlay" onClick={onClose}>
      <div className="profile-modal" onClick={e => e.stopPropagation()}>
        <button className="profile-modal__close" onClick={onClose}>&times;</button>
        <div className="profile-modal__body">
          <h2 className="profile-modal__title">Edit profile</h2>
          <form onSubmit={handleSubmit}>
            <div className="profile-modal__avatar-section">
              <div
                className="profile-modal__avatar"
                onClick={() => fileRef.current?.click()}
                title={anon?.name}
                style={anon && !hasUserAvatar ? { backgroundColor: anon.color, color: '#fff' } : undefined}
              >
                {hasUserAvatar ? (
                  <img src={avatarSrc!} alt="" referrerPolicy="no-referrer" />
                ) : showAnimal ? (
                  <img
                    src={anon!.avatarPath!}
                    alt=""
                    className="profile-modal__avatar-anon"
                    onError={() => setAnonImgFailed(true)}
                  />
                ) : (
                  <span>{initials}</span>
                )}
                <div className="profile-modal__avatar-overlay">
                  <span className="material-icons-outlined">photo_camera</span>
                </div>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
              {(avatarSrc && avatarSrc !== '__remove__') && (
                <button type="button" className="profile-modal__remove-btn" onClick={handleRemoveAvatar}>
                  Remove photo
                </button>
              )}
            </div>
            <label className="profile-modal__label">Name</label>
            <input
              type="text"
              className="profile-modal__input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Your name"
            />
            <label className="profile-modal__label">My language</label>
            <div className="profile-modal__lang-row">
              {nativeLanguage && getFlagUrl(nativeLanguage) && (
                <img
                  src={getFlagUrl(nativeLanguage)}
                  alt=""
                  width="20"
                  height="15"
                  className="profile-modal__lang-flag"
                />
              )}
              <select
                className="profile-modal__input profile-modal__lang-select"
                value={nativeLanguage}
                onChange={e => setNativeLanguage(e.target.value)}
              >
                <option value="">— not set —</option>
                {POPULAR_LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>
                    {l.englishName} ({l.nativeName})
                  </option>
                ))}
                {user.nativeLanguage && !POPULAR_LANGUAGES.some(l => l.code === user.nativeLanguage) && (() => {
                  const lang = getLanguage(user.nativeLanguage!)
                  return lang ? (
                    <option key={lang.code} value={lang.code}>
                      {lang.englishName} ({lang.nativeName})
                    </option>
                  ) : (
                    <option value={user.nativeLanguage!}>{user.nativeLanguage}</option>
                  )
                })()}
              </select>
            </div>
            <p className="profile-modal__hint">Used for translations, word definitions, and vocabulary cards in the reader.</p>
            {!isGuest && (
              <>
                <label className="profile-modal__label">Email</label>
                <input
                  type="email"
                  className="profile-modal__input profile-modal__input--disabled"
                  value={user.email}
                  disabled
                />
              </>
            )}
            {error && <p className="profile-modal__error">{error}</p>}
            <button className="profile-modal__btn" type="submit" disabled={loading}>
              {loading ? 'Saving...' : 'Save changes'}
            </button>
          </form>
          {!isGuest && (
            <section className="profile-modal__danger-zone">
              <h3 className="profile-modal__danger-title">{t('deleteAccount.dangerZone')}</h3>
              <p className="profile-modal__danger-desc">{t('deleteAccount.sectionDesc')}</p>
              <button
                type="button"
                className="profile-modal__btn profile-modal__btn--danger"
                onClick={() => setShowDeleteAccount(true)}
              >
                {t('deleteAccount.openButton')}
              </button>
            </section>
          )}
        </div>
      </div>
      {showDeleteAccount && <DeleteAccountDialog onClose={() => setShowDeleteAccount(false)} />}
    </div>,
    document.body,
  )
}
