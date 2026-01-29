import { useState } from 'react'
import { LocalizedLink } from './LocalizedLink'
import { MobileSearchOverlay } from './Search'
import { LanguageSwitcher } from './LanguageSwitcher'
import { LoginButton } from './auth/LoginButton'
import { UserMenu } from './auth/UserMenu'
import { useAuth } from '../context/AuthContext'
import { useScrolled } from '../hooks/useScrolled'
import { useDarkMode } from '../hooks/useDarkMode'

export function Header() {
  const [searchOpen, setSearchOpen] = useState(false)
  const { isAuthenticated, isLoading } = useAuth()
  const isScrolled = useScrolled(50)
  const { isDark, toggleTheme } = useDarkMode()

  return (
    <header className={`site-header ${isScrolled ? 'site-header--scrolled' : ''}`}>
      <div className="site-header__left">
        <LocalizedLink to="/" className="site-header__brand" title="TextStack - Free online library">
          <span className="site-header__wordmark">TextStack</span>
        </LocalizedLink>
        <nav className="site-header__nav-links">
          <LocalizedLink to="/books" className="site-header__nav-link" title="Browse all books">
            Catalog
          </LocalizedLink>
          {isAuthenticated && (
            <LocalizedLink to="/library" className="site-header__nav-link" title="My Library">
              My Library
            </LocalizedLink>
          )}
          <LocalizedLink to="/about" className="site-header__nav-link" title="About TextStack">
            About
          </LocalizedLink>
        </nav>
      </div>
      <div className="site-header__right">
        <LanguageSwitcher />
        <button
          className="site-header__icon-btn"
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <span className="material-icons-outlined">{isDark ? 'light_mode' : 'dark_mode'}</span>
        </button>
        <button
          className="site-header__icon-btn"
          onClick={() => setSearchOpen(true)}
          aria-label="Search"
        >
          <span className="material-icons-outlined">search</span>
        </button>
        {!isLoading && (isAuthenticated ? <UserMenu /> : <LoginButton />)}
      </div>
      {searchOpen && <MobileSearchOverlay onClose={() => setSearchOpen(false)} />}
    </header>
  )
}
