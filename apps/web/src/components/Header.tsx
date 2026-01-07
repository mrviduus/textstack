import { useState } from 'react'
import { LocalizedLink } from './LocalizedLink'
import { MobileSearchOverlay } from './Search'
import { useSite } from '../context/SiteContext'

export function Header() {
  const [searchOpen, setSearchOpen] = useState(false)
  const { site } = useSite()
  const isProgramming = site?.siteCode === 'programming'

  return (
    <header className="site-header">
      <LocalizedLink to="/" className="site-header__brand">
        <span className="site-header__wordmark">
          TextStack{isProgramming && <span className="site-header__wordmark-suffix">dev</span>}
        </span>
      </LocalizedLink>
      <nav className="site-header__nav">
        <LocalizedLink to="/about" className="site-header__nav-link">
          About
        </LocalizedLink>
      </nav>
      <button
        className="search-btn"
        onClick={() => setSearchOpen(true)}
        aria-label="Search"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      </button>
      {searchOpen && <MobileSearchOverlay onClose={() => setSearchOpen(false)} />}
    </header>
  )
}
