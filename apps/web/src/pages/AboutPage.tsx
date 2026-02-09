import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { useTranslation } from '../hooks/useTranslation'
import './AboutPage.css'

export function AboutPage() {
  const { t } = useTranslation()

  return (
    <>
    <div className="about-page">
      <SeoHead
        title={t('about.seoTitle')}
        description={t('about.seoDesc')}
      />

      <div className="about-page__grid">
        {/* Left Column - Content */}
        <div className="about-page__content">
          <header className="about-page__header">
            <h1 className="about-page__title">{t('about.title')}</h1>
            <div className="about-page__accent-bar" />
          </header>

          <section className="about-page__body">
            <p className="about-page__intro">
              {t('about.intro')}
            </p>

            <div className="about-page__prose">
              <p>{t('about.body1')}</p>

              <h2 className="about-page__mission-heading">{t('about.missionHeading')}</h2>

              <p>{t('about.mission1')}</p>

              <p>{t('about.mission2')}</p>
            </div>
          </section>
        </div>

        {/* Right Column - Creator Card */}
        <div className="about-page__sidebar">
          <div className="about-creator-card">
            <h3 className="about-creator-card__heading">{t('about.creator.heading')}</h3>

            <div className="about-creator-card__content">
              <div className="about-creator-card__photo-wrapper">
                <img
                  src="/images/vasyl-vdovychenko.png"
                  alt="Vasyl Vdovychenko"
                  title="Vasyl Vdovychenko - Creator of TextStack"
                  className="about-creator-card__photo"
                />
              </div>

              <div className="about-creator-card__info">
                <h4 className="about-creator-card__name">Vasyl Vdovychenko</h4>
                <p className="about-creator-card__email">vasyl.vdov@gmail.com</p>
              </div>

              <div className="about-creator-card__bio">
                <p>{t('about.creator.bio1')}</p>
                <p>{t('about.creator.bio2')}</p>
              </div>

              <div className="about-creator-card__buttons">
                <a
                  href="mailto:vasyl.vdov@gmail.com"
                  className="about-creator-card__btn about-creator-card__btn--primary"
                  title="Send email to Vasyl Vdovychenko"
                >
                  <span className="material-icons-outlined">mail</span>
                  {t('about.creator.email')}
                </a>

                <a
                  href="https://www.linkedin.com/in/vasyl-vdovychenko/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="about-creator-card__btn"
                  title="Connect on LinkedIn"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
                  </svg>
                  {t('about.creator.linkedin')}
                </a>

                <a
                  href="https://vasyl.blog/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="about-creator-card__btn about-creator-card__btn--full"
                  title="Visit personal blog"
                >
                  <span className="material-icons-outlined">edit_note</span>
                  {t('about.creator.blog')}
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <Footer />
    </>
  )
}
