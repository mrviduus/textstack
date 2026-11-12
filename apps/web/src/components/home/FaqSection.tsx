import { useState } from 'react'
import { useTranslation } from '../../hooks/useTranslation'

const FAQ_KEYS = [
  'whatIs',
  'isFree',
  'techBooks',
  'languages',
  'tapTranslate',
  'uploadBooks',
  'srsCards',
  'offline',
  'mobileApp',
  'installAndroid',
  'connectAssistant',
  'deleteAccount',
  'vsFriends',
] as const

export function FaqSection() {
  const { t } = useTranslation()
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  const toggle = (i: number) => setOpenIndex(prev => (prev === i ? null : i))

  return (
    <section className="home-faq" aria-labelledby="home-faq-heading">
      <div className="home-faq__inner">
        <h2 className="home-faq__heading" id="home-faq-heading">
          {t('home.faq.heading')}
        </h2>
        <p className="home-faq__subheading">{t('home.faq.subheading')}</p>

        <div className="home-faq__list" role="list">
          {FAQ_KEYS.map((key, i) => {
            const isOpen = openIndex === i
            return (
              <div
                key={key}
                className={`home-faq__item${isOpen ? ' home-faq__item--open' : ''}`}
                role="listitem"
              >
                <button
                  className="home-faq__question"
                  onClick={() => toggle(i)}
                  aria-expanded={isOpen}
                  aria-controls={`faq-answer-${key}`}
                >
                  <span>{t(`home.faq.${key}.q`)}</span>
                  <span className="home-faq__chevron" aria-hidden="true">
                    {isOpen ? '−' : '+'}
                  </span>
                </button>
                <div
                  id={`faq-answer-${key}`}
                  className="home-faq__answer"
                  role="region"
                  hidden={!isOpen}
                >
                  <p>{t(`home.faq.${key}.a`)}</p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
