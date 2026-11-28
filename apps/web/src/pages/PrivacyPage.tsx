import { SeoHead } from '../components/SeoHead'
import { useTranslation } from '../hooks/useTranslation'
import { useObfuscatedEmail } from '../hooks/useObfuscatedEmail'
import { PRIVACY_SECTIONS } from '@textstack/shared'
import './LegalPage.css'

export function PrivacyPage() {
  const { t } = useTranslation()
  const { email, mailto } = useObfuscatedEmail()

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

      {/* Section order lives in @textstack/shared so this page and the mobile screen
          cannot drift apart — Play requires the in-app policy and the policy at the
          listed URL to say the same thing. */}
      {PRIVACY_SECTIONS.map(section => (
        <section className="legal-page__section" key={section.heading}>
          <h2>{t(section.heading)}</h2>
          {section.bodies.map(body => (
            <p key={body}>{t(body)}</p>
          ))}
          {section.link ? (
            <p>
              <a href={section.link.url}>{t(section.link.label)}</a>
            </p>
          ) : null}
        </section>
      ))}

      <section className="legal-page__section">
        <h2>{t('privacy.contactHeading')}</h2>
        <p>
          {t('privacy.contactBody')}{' '}
          <a href={mailto}>{email}</a>.
        </p>
      </section>
      </div>
    </>
  )
}
