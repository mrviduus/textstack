import { LocalizedLink } from './LocalizedLink'
import { LoginButton } from './auth/LoginButton'
import { UserMenu } from './auth/UserMenu'
import { useAuth } from '../context/AuthContext'
import { useScrolled } from '../hooks/useScrolled'
import { useDarkMode } from '../hooks/useDarkMode'
import { useTranslation } from '../hooks/useTranslation'
import { UploadButton } from './library/UploadButton'
import { emit } from '../lib/telemetry/navTelemetry'

export function Header() {
  const { isAuthenticated, isLoading } = useAuth()
  const isScrolled = useScrolled(50)
  const { isDark, toggleTheme } = useDarkMode()
  const { t } = useTranslation()

  return (
    <header className={`site-header ${isScrolled ? 'site-header--scrolled' : ''}`}>
      <div className="site-header__left">
        <LocalizedLink
          to={isAuthenticated ? '/library' : '/'}
          className="site-header__brand"
          title={t('nav.brandTitle')}
          onClick={() => emit('header.click', { item: 'logo', auth: isAuthenticated })}
        >
          <span className="site-header__wordmark">TextStack</span>
        </LocalizedLink>
        <nav className="site-header__nav-links">
          {isAuthenticated && (
            <LocalizedLink
              to="/library"
              className="site-header__nav-link"
              title={t('nav.library')}
              onClick={() => emit('header.click', { item: 'library' })}
            >
              {t('nav.library')}
            </LocalizedLink>
          )}
          {isAuthenticated && (
            <LocalizedLink
              to="/vocabulary"
              className="site-header__nav-link"
              title={t('nav.vocabulary')}
              onClick={() => emit('header.click', { item: 'vocabulary' })}
            >
              {t('nav.vocabulary')}
            </LocalizedLink>
          )}
          {isAuthenticated && (
            <LocalizedLink
              to="/highlights"
              className="site-header__nav-link"
              title={t('nav.highlights')}
              onClick={() => emit('header.click', { item: 'highlights' })}
            >
              {t('nav.highlights')}
            </LocalizedLink>
          )}
          {!isAuthenticated && (
            <LocalizedLink
              to="/about"
              className="site-header__nav-link site-header__nav-link--secondary"
              title={t('nav.aboutTextStack')}
            >
              {t('nav.about')}
            </LocalizedLink>
          )}
        </nav>
      </div>
      <div className="site-header__right">
        <UploadButton />
        <button
          className="site-header__icon-btn"
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <span className="material-icons-outlined">{isDark ? 'light_mode' : 'dark_mode'}</span>
        </button>
        {!isLoading && (isAuthenticated ? <UserMenu /> : <LoginButton />)}
      </div>
    </header>
  )
}
