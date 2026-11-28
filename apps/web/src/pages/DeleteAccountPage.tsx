import { SeoHead } from '../components/SeoHead'
import { useTranslation } from '../hooks/useTranslation'
import { useObfuscatedEmail } from '../hooks/useObfuscatedEmail'
import './LegalPage.css'

export function DeleteAccountPage() {
  const { t } = useTranslation()
  const { email, mailto } = useObfuscatedEmail()

  return (
    <>
      <div className="legal-page">
        <SeoHead
          title={t('deleteAccount.seoTitle')}
          description={t('deleteAccount.seoDesc')}
        />

        <header className="legal-page__header">
          <h1 className="legal-page__title">{t('deleteAccount.pageTitle')}</h1>
          <div className="legal-page__accent-bar" />
        </header>

        <p className="legal-page__intro">{t('deleteAccount.intro')}</p>

        <section className="legal-page__section">
          <h2>{t('deleteAccount.inAppHeading')}</h2>
          <p>{t('deleteAccount.inAppBody')}</p>
        </section>

        <section className="legal-page__section">
          <h2>{t('deleteAccount.onWebHeading')}</h2>
          <p>{t('deleteAccount.onWebBody')}</p>
        </section>

        <section className="legal-page__section">
          <h2>{t('deleteAccount.dataHeading')}</h2>
          <p>{t('deleteAccount.dataBody')}</p>
        </section>

        <section className="legal-page__section">
          <h2>{t('deleteAccount.retentionHeading')}</h2>
          <p>{t('deleteAccount.retentionBody')}</p>
        </section>

        <section className="legal-page__section">
          <h2>{t('deleteAccount.contactHeading')}</h2>
          <p>
            {t('deleteAccount.contactBody')}{' '}
            <a href={mailto}>{email}</a>.
          </p>
        </section>
      </div>
    </>
  )
}
