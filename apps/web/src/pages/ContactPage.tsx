import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { useTranslation } from '../hooks/useTranslation'
import './LegalPage.css'

export function ContactPage() {
  const { t } = useTranslation()

  return (
    <>
      <div className="legal-page">
      <SeoHead
        title={t('contact.seoTitle')}
        description={t('contact.seoDesc')}
      />

      <header className="legal-page__header">
        <h1 className="legal-page__title">{t('contact.title')}</h1>
        <div className="legal-page__accent-bar" />
      </header>

      <p className="legal-page__intro">
        {t('contact.intro')}
      </p>

      <div className="legal-page__contact-card">
        <div className="legal-page__contact-item">
          <span className="material-icons-outlined">mail</span>
          <a href="mailto:vasyl.vdov@gmail.com">vasyl.vdov@gmail.com</a>
        </div>
      </div>

      <section className="legal-page__section">
        <h2>{t('contact.reachOutHeading')}</h2>
        <ul>
          <li>{t('contact.reachOut1')}</li>
          <li>{t('contact.reachOut2')}</li>
          <li>{t('contact.reachOut3')}</li>
          <li>{t('contact.reachOut4')}</li>
          <li>{t('contact.reachOut5')}</li>
        </ul>
      </section>

      <section className="legal-page__section">
        <h2>{t('contact.responseHeading')}</h2>
        <p>{t('contact.responseBody')}</p>
      </section>
      </div>
      <Footer />
    </>
  )
}
