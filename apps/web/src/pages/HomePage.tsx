import { SeoHead } from '../components/SeoHead'
import { HeroSection } from '../components/home/HeroSection'
import { FeaturesSection } from '../components/home/FeaturesSection'
import { ComparisonSection } from '../components/home/ComparisonSection'
import { FaqSection } from '../components/home/FaqSection'
import { useTranslation } from '../hooks/useTranslation'
import '../styles/home.css'

export function HomePage() {
  const { t } = useTranslation()

  return (
    <>
      <div className="home-page">
        <SeoHead
          title={t('home.hero.seoTitle')}
          description={t('home.hero.seoDescription')}
        />
        <HeroSection />
        <FeaturesSection />
        <ComparisonSection />
        <FaqSection />
      </div>
    </>
  )
}
