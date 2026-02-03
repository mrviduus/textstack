import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from '../../hooks/useTranslation'
import { useLanguage } from '../../context/LanguageContext'
import { MobileSearchOverlay } from '../Search'

export function HeroSection() {
  const { t } = useTranslation()
  const { language } = useLanguage()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [isMobile, setIsMobile] = useState(false)
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false)

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim()) {
      navigate(`/${language}/search?q=${encodeURIComponent(query.trim())}`)
    }
  }

  const handleInputFocus = () => {
    if (isMobile) {
      setSearchOverlayOpen(true)
    }
  }

  return (
    <section className="home-hero">
      <div className="home-hero__content">
        <h1 className="home-hero__title">{t('home.hero.title')}</h1>
        <p className="home-hero__subtitle">{t('home.hero.subtitle')}</p>
        <form className="home-hero__search" onSubmit={handleSearch}>
          <span className="material-icons-outlined home-hero__search-icon">search</span>
          <input
            type="text"
            className="home-hero__search-input"
            placeholder="Search by title, author, or genre..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={handleInputFocus}
            readOnly={isMobile}
          />
        </form>
      </div>
      {searchOverlayOpen && <MobileSearchOverlay onClose={() => setSearchOverlayOpen(false)} />}
    </section>
  )
}
