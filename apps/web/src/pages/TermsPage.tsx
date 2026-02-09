import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { useTranslation } from '../hooks/useTranslation'
import './LegalPage.css'

export function TermsPage() {
  const { t } = useTranslation()

  return (
    <>
      <div className="legal-page">
      <SeoHead
        title={t('terms.seoTitle')}
        description={t('terms.seoDesc')}
      />

      <header className="legal-page__header">
        <h1 className="legal-page__title">{t('terms.title')}</h1>
        <div className="legal-page__accent-bar" />
      </header>

      <p className="legal-page__intro">{t('terms.intro')}</p>

      <p className="legal-page__updated">{t('terms.updated')}</p>

      <section className="legal-page__section">
        <h2>{t('terms.acceptanceHeading')}</h2>
        <p>{t('terms.acceptanceBody')}</p>
      </section>

      <section className="legal-page__section">
        <h2>{t('terms.contentHeading')}</h2>
        <p>{t('terms.contentBody1')}</p>
        <p>{t('terms.contentBody2')}</p>
      </section>

      <section className="legal-page__section">
        <h2>{t('terms.useHeading')}</h2>
        <p>{t('terms.useIntro')}</p>
        <ul>
          <li>{t('terms.use1')}</li>
          <li>{t('terms.use2')}</li>
          <li>{t('terms.use3')}</li>
          <li>{t('terms.use4')}</li>
        </ul>
      </section>

      <section className="legal-page__section">
        <h2>{t('terms.ipHeading')}</h2>
        <p>{t('terms.ipBody1')}</p>
        <p>{t('terms.ipBody2')}</p>
      </section>

      <section className="legal-page__section">
        <h2>{t('terms.disclaimerHeading')}</h2>
        <p>{t('terms.disclaimerBody1')}</p>
        <p>{t('terms.disclaimerBody2')}</p>
      </section>

      <section className="legal-page__section">
        <h2>{t('terms.changesHeading')}</h2>
        <p>{t('terms.changesBody')}</p>
      </section>

      <section className="legal-page__section">
        <h2>{t('terms.contactHeading')}</h2>
        <p>
          {t('terms.contactBody')}{' '}
          <a href="mailto:vasyl.vdov@gmail.com">vasyl.vdov@gmail.com</a>.
        </p>
      </section>
      </div>
      <Footer />
    </>
  )
}
