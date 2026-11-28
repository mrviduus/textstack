import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { useTranslation } from '../hooks/useTranslation'
import { LocalizedLink } from './LocalizedLink'
import { ProfileModal } from './auth/ProfileModal'

/**
 * The phone's bottom navigation: Library, add a book, Vocabulary, Profile. Hidden above phone width
 * (styles/app-shell.css). While it is mounted, `html.has-tab-bar` lets the CSS make room for it and hide
 * the header's copies of the same actions.
 */
export function TabBar() {
  const { isAuthenticated, openAuthModal } = useAuth()
  const { getLocalizedPath } = useLanguage()
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const [showProfile, setShowProfile] = useState(false)

  useEffect(() => {
    document.documentElement.classList.add('has-tab-bar')
    return () => document.documentElement.classList.remove('has-tab-bar')
  }, [])

  const tab = (to: string, icon: string, label: string) => {
    // A localized path ends with a slash; the address may not.
    const active = `${pathname}/`.startsWith(getLocalizedPath(to))
    return (
      <LocalizedLink to={to} className={`tab-bar__tab${active ? ' tab-bar__tab--active' : ''}`} aria-current={active ? 'page' : undefined}>
        <span className="material-icons-outlined" aria-hidden="true">{icon}</span>
        <span className="tab-bar__label">{label}</span>
      </LocalizedLink>
    )
  }

  return (
    <>
      <nav className="tab-bar" aria-label={t('nav.tabs')}>
        {tab('/library', 'library_books', t('nav.library'))}
        <button
          type="button"
          className="tab-bar__add"
          aria-label={t('upload.button')}
          // The header's UploadButton owns the upload dialog and listens for this event.
          onClick={() => (isAuthenticated ? window.dispatchEvent(new Event('textstack:open-upload')) : openAuthModal())}
        >
          <span className="material-icons-outlined" aria-hidden="true">add</span>
        </button>
        {tab('/vocabulary', 'school', t('nav.vocabulary'))}
        <button
          type="button"
          className="tab-bar__tab"
          onClick={() => (isAuthenticated ? setShowProfile(true) : openAuthModal())}
        >
          <span className="material-icons-outlined" aria-hidden="true">person</span>
          <span className="tab-bar__label">{t('nav.profile')}</span>
        </button>
      </nav>
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
    </>
  )
}
