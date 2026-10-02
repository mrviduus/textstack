import { useState, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { LocalizedLink } from './LocalizedLink'
import { DiscoverMenu } from './DiscoverMenu'
import { MobileSearchOverlay } from './Search'
import { LoginButton } from './auth/LoginButton'
import { UserMenu } from './auth/UserMenu'
import { useAuth } from '../context/AuthContext'
import { useScrolled } from '../hooks/useScrolled'
import { useDarkMode } from '../hooks/useDarkMode'
import { useTranslation } from '../hooks/useTranslation'
import { useQuickStats } from '../hooks/useQuickStats'
import { StreakBadge } from './StreakBadge'
import { VocabBadgePopup } from './VocabBadgePopup'
import { UploadButton } from './library/UploadButton'
import { emit } from '../lib/telemetry/navTelemetry'

export function Header() {
  const [badgePopup, setBadgePopup] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const badgeWrapperRef = useRef<HTMLDivElement>(null)
  const { isAuthenticated, isLoading } = useAuth()
  const isScrolled = useScrolled(50)
  const { isDark, toggleTheme } = useDarkMode()
  const { t } = useTranslation()
  const quickStats = useQuickStats({ includeReading: false })
  // Suppress the header search icon on the home page — HeroSection already
  // renders a prominent search input there, so duplicating it in the chrome
  // would be visual noise. On every other route the hero is gone, and users
  // have nowhere else to launch a search from (was the regression that
  // motivated bringing the icon back — see 3e53e3e for the removal).
  const location = useLocation()
  const isHomePage = /^\/(en|uk)?\/?$/.test(location.pathname)

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
          <DiscoverMenu />
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
        {!isHomePage && (
          <button
            className="site-header__icon-btn"
            onClick={() => {
              emit('header.click', { item: 'search' })
              setSearchOpen(true)
            }}
            aria-label={t('nav.search')}
            title={t('nav.search')}
          >
            <span className="material-icons-outlined">search</span>
          </button>
        )}
        <button
          className="site-header__icon-btn"
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <span className="material-icons-outlined">{isDark ? 'light_mode' : 'dark_mode'}</span>
        </button>
        {isAuthenticated && quickStats && (quickStats.vocabDueNow > 0 || quickStats.vocabReviewedToday > 0) && (
          <div className="streak-badge-wrapper" ref={badgeWrapperRef}>
            <button
              className="streak-badge"
              onClick={() => setBadgePopup(v => !v)}
              title={t('nav.vocabulary')}
            >
              <StreakBadge
                reviewed={quickStats.vocabReviewedToday}
                due={quickStats.vocabDueNow}
                streak={quickStats.vocabStreak}
              />
            </button>
            {badgePopup && (
              <VocabBadgePopup
                reviewed={quickStats.vocabReviewedToday}
                due={quickStats.vocabDueNow}
                streak={quickStats.vocabStreak}
                containerRef={badgeWrapperRef}
                onClose={() => setBadgePopup(false)}
              />
            )}
          </div>
        )}
        {!isLoading && (isAuthenticated ? <UserMenu /> : <LoginButton />)}
      </div>
      {searchOpen && <MobileSearchOverlay onClose={() => setSearchOpen(false)} />}
    </header>
  )
}
