import { useTranslation } from '../../hooks/useTranslation'
import { useSite } from '../../context/SiteContext'
import { LocalizedLink } from '../LocalizedLink'

export function HeroSection() {
  const { t } = useTranslation()
  const { site } = useSite()

  const isProgramming = site?.siteCode === 'programming'
  const heroClass = isProgramming ? 'home-hero home-hero--programming' : 'home-hero'

  const title = isProgramming ? t('home.hero.programming.title') : t('home.hero.title')
  const subtitle = isProgramming ? t('home.hero.programming.subtitle') : t('home.hero.subtitle')
  const description = isProgramming ? t('home.hero.programming.description') : t('home.hero.description')

  return (
    <section className={heroClass}>
      <div className="home-hero__content">
        <h1 className="home-hero__title">{title}</h1>
        <p className="home-hero__subtitle">{subtitle}</p>
        <p className="home-hero__description">{description}</p>
        <LocalizedLink to="/books" className="home-hero__cta">
          {t('home.hero.cta')}
        </LocalizedLink>
      </div>
    </section>
  )
}
