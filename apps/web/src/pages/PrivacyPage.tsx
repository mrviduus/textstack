import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { useTranslation } from '../hooks/useTranslation'
import './LegalPage.css'

export function PrivacyPage() {
  const { t } = useTranslation()

  return (
    <>
      <div className="legal-page">
      <SeoHead
        title={t('privacy.seoTitle')}
        description={t('privacy.seoDesc')}
      />

      <header className="legal-page__header">
        <h1 className="legal-page__title">{t('privacy.title')}</h1>
        <div className="legal-page__accent-bar" />
      </header>

      <p className="legal-page__intro">{t('privacy.intro')}</p>

      <p className="legal-page__updated">{t('privacy.updated')}</p>

      <section className="legal-page__section">
        <h2>{t('privacy.collectHeading')}</h2>
        <p>{t('privacy.collectBody1')}</p>
        <p>{t('privacy.collectBody2')}</p>
      </section>

      <section className="legal-page__section">
        <h2>{t('privacy.cookiesHeading')}</h2>
        <p>{t('privacy.cookiesBody1')}</p>
        <p>{t('privacy.cookiesBody2')}</p>
      </section>

      <section className="legal-page__section">
        <h2>{t('privacy.thirdPartiesHeading')}</h2>
        <p>{t('privacy.thirdPartiesBody')}</p>
      </section>

      <section className="legal-page__section">
        <h2>{t('privacy.storageHeading')}</h2>
        <p>{t('privacy.storageBody1')}</p>
        <p>{t('privacy.storageBody2')}</p>
      </section>

      <section className="legal-page__section">
        <h2>{t('privacy.rightsHeading')}</h2>
        <p>{t('privacy.rightsBody')}</p>
      </section>

      <section className="legal-page__section">
        <h2>{t('privacy.contactHeading')}</h2>
        <p>
          {t('privacy.contactBody')}{' '}
          <a href="mailto:vasyl.vdov@gmail.com">vasyl.vdov@gmail.com</a>.
        </p>
      </section>
      </div>
      <Footer />
    </>
  )
}
