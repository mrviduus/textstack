import { SeoHead } from '../components/SeoHead'
import { HeroSection } from '../components/home/HeroSection'
import { RecentAuthorsSection } from '../components/home/RecentAuthorsSection'
import { RecentBooksSection } from '../components/home/RecentBooksSection'
import { Footer } from '../components/Footer'
import { useTranslation } from '../hooks/useTranslation'
import '../styles/home.css'

export function HomePage() {
  const { t } = useTranslation()

  return (
    <>
      <div className="home-page">
        <SeoHead
          title={t('home.hero.title')}
          description={t('home.hero.subtitle')}
        />
        <HeroSection />
        <RecentBooksSection />
        <RecentAuthorsSection />
      </div>
      <Footer />
    </>
  )
}
