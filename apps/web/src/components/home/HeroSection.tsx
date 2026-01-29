import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from '../../hooks/useTranslation'
import { useLanguage } from '../../context/LanguageContext'

export function HeroSection() {
  const { t } = useTranslation()
  const { language } = useLanguage()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim()) {
      navigate(`/${language}/search?q=${encodeURIComponent(query.trim())}`)
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
          />
        </form>
      </div>
    </section>
  )
}
