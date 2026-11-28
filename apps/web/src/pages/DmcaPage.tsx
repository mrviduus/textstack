import { SeoHead } from '../components/SeoHead'
import { useTranslation } from '../hooks/useTranslation'
import { useObfuscatedEmail } from '../hooks/useObfuscatedEmail'
import './LegalPage.css'

export function DmcaPage() {
  const { t } = useTranslation()
  const { email, mailto } = useObfuscatedEmail()

  return (
    <>
      <div className="legal-page">
        <SeoHead
          title={t('dmca.seoTitle')}
          description={t('dmca.seoDesc')}
        />

        <header className="legal-page__header">
          <h1 className="legal-page__title">{t('dmca.title')}</h1>
          <div className="legal-page__accent-bar" />
        </header>

        <p className="legal-page__intro">{t('dmca.intro')}</p>
        <p className="legal-page__updated">{t('dmca.updated')}</p>

        <section className="legal-page__section">
          <h2>{t('dmca.howHeading')}</h2>
          <p>{t('dmca.howBody')}</p>
          <ul>
            <li>{t('dmca.req1')}</li>
            <li>{t('dmca.req2')}</li>
            <li>{t('dmca.req3')}</li>
            <li>{t('dmca.req4')}</li>
            <li>{t('dmca.req5')}</li>
            <li>{t('dmca.req6')}</li>
          </ul>
        </section>

        <section className="legal-page__section">
          <h2>{t('dmca.sendHeading')}</h2>
          <p>
            {t('dmca.sendBody')}{' '}
            <a href={mailto}>{email}</a>.
          </p>
          <p>{t('dmca.sendNote')}</p>
        </section>

        <section className="legal-page__section">
          <h2>{t('dmca.processHeading')}</h2>
          <p>{t('dmca.processBody1')}</p>
          <p>{t('dmca.processBody2')}</p>
        </section>

        <section className="legal-page__section">
          <h2>{t('dmca.counterHeading')}</h2>
          <p>{t('dmca.counterBody')}</p>
        </section>

        <section className="legal-page__section">
          <h2>{t('dmca.repeatHeading')}</h2>
          <p>{t('dmca.repeatBody')}</p>
        </section>

        <section className="legal-page__section">
          <h2>{t('dmca.misuseHeading')}</h2>
          <p>{t('dmca.misuseBody')}</p>
        </section>
      </div>
    </>
  )
}
