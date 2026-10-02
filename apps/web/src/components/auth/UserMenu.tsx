import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { ProfileModal } from './ProfileModal'
import { GuestDeleteDialog } from './GuestDeleteDialog'
import { useTranslation } from '../../hooks/useTranslation'
import { useOnline } from '../../hooks/useOnline'
import { getUserInitials } from '../../lib/userInitials'

export function UserMenu() {
  const { user, logout, openAuthModal } = useAuth()
  const { t } = useTranslation()
  const online = useOnline()
  const [open, setOpen] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [showGuestDelete, setShowGuestDelete] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }

    if (open) {
      document.addEventListener('click', handleClick)
      return () => document.removeEventListener('click', handleClick)
    }
  }, [open])

  if (!user) return null

  const isGuest = !!user.isGuest
  const displayName = isGuest ? (user.name || t('guest.name')) : (user.name || 'User')
  // A guest's email is synthetic (guest-<hex>@guest.local) — never show it.
  const displaySubtitle = isGuest ? t('userMenu.anonymousReader') : user.email
  const tooltip = displayName
  const initials = getUserInitials(user)

  const avatarSrc = user.picture?.startsWith('http')
    ? user.picture
    : user.picture ? `/storage/${user.picture}` : null

  return (
    <>
      <div className="user-menu" ref={menuRef}>
        <button
          className="user-menu__trigger"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-haspopup="true"
          title={tooltip}
          aria-label={tooltip}
        >
          {avatarSrc ? (
            <img src={avatarSrc} alt="" className="user-menu__avatar-img" referrerPolicy="no-referrer" />
          ) : (
            <span className="user-menu__avatar">{initials}</span>
          )}
          <span
            className={`user-menu__status-dot${online ? ' user-menu__status-dot--online' : ''}`}
            title={online ? 'Online' : 'Offline'}
            aria-label={online ? 'Online' : 'Offline'}
          />
        </button>

        {open && (
          <div className="user-menu__dropdown">
            <div className="user-menu__info">
              <span className="user-menu__name">{displayName}</span>
              <span className="user-menu__email">{displaySubtitle}</span>
            </div>
            <hr className="user-menu__divider" />
            {isGuest && (
              <>
                <button
                  className="user-menu__item user-menu__item--primary"
                  onClick={() => { setOpen(false); openAuthModal('register') }}
                >
                  {t('guest.createAccount')}
                </button>
                <button
                  className="user-menu__item"
                  onClick={() => { setOpen(false); openAuthModal('login') }}
                >
                  {t('guest.cardSignIn')}
                </button>
                <hr className="user-menu__divider" />
              </>
            )}
            <button
              className="user-menu__item"
              onClick={() => { setOpen(false); setShowProfile(true) }}
            >
              Edit profile
            </button>
            <hr className="user-menu__divider" />
            {isGuest ? (
              // A guest has no credentials to come back with — "sign out" would orphan the row.
              // The honest action is deleting it, behind a confirm.
              <button
                className="user-menu__item user-menu__item--danger"
                onClick={() => { setOpen(false); setShowGuestDelete(true) }}
              >
                {t('guest.deleteData')}
              </button>
            ) : (
              <button
                className="user-menu__item user-menu__item--danger"
                onClick={() => {
                  setOpen(false)
                  logout()
                }}
              >
                Sign out
              </button>
            )}
          </div>
        )}
      </div>
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
      {showGuestDelete && <GuestDeleteDialog onClose={() => setShowGuestDelete(false)} />}
    </>
  )
}
