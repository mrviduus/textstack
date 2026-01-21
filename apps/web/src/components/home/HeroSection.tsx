import { useTranslation } from '../../hooks/useTranslation'
import { LocalizedLink } from '../LocalizedLink'

export function HeroSection() {
  const { t } = useTranslation()

  return (
    <section className="home-hero">
      <div className="home-hero__content">
        <h1 className="home-hero__title">{t('home.hero.title')}</h1>
        <p className="home-hero__subtitle">{t('home.hero.subtitle')}</p>
        <p className="home-hero__description">{t('home.hero.description')}</p>
        <LocalizedLink to="/books" className="home-hero__cta" title="Browse all books">
          {t('home.hero.cta')}
        </LocalizedLink>
      </div>
    </section>
  )
}
