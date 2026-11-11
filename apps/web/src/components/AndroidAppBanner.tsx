import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from '../hooks/useTranslation'
import '../styles/android-app-banner.css'

const STORAGE_KEY = 'androidTesterBanner'
const READ_KEY = 'androidTesterBanner.hasRead'
const COOKIE_KEY = 'cookieConsent'

export const PLAY_URL = 'https://play.google.com/store/apps/details?id=app.textstack.mobile'

/**
 * Reader routes: /:lang/books/:book/:chapter and /:lang/library/my/:id/read[/:chapter].
 * The trailing slash is not optional in production — nginx 301s chapter URLs to it — so a
 * pattern anchored on the bare segment matches locally and never matches on the live site.
 */
const READER_PATH = /\/books\/[^/]+\/[^/]+\/?$|\/library\/my\/[^/]+\/read/

function isAndroid() {
  return /Android/i.test(navigator.userAgent)
}

/**
 * Points Android readers at the Play listing. Deliberately narrow: it waits until someone
 * has actually opened a book, so it asks readers, not drive-by visitors. The storage keys
 * keep their old "tester" names, so whoever dismissed the beta invite stays dismissed.
 */
export function AndroidAppBanner() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const [visible, setVisible] = useState(false)

  const inReader = READER_PATH.test(pathname)

  // Remember that this visitor reads, so the banner can wait for the second visit.
  useEffect(() => {
    if (inReader) localStorage.setItem(READ_KEY, '1')
  }, [inReader])

  useEffect(() => {
    if (inReader) {
      setVisible(false)
      return
    }
    if (!isAndroid()) return
    if (localStorage.getItem(STORAGE_KEY)) return
    // One banner at a time — the cookie bar owns the bottom of the screen until answered.
    if (!localStorage.getItem(COOKIE_KEY)) return
    if (!localStorage.getItem(READ_KEY)) return
    setVisible(true)
  }, [inReader, pathname])

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, 'dismissed')
    setVisible(false)
  }

  const open = () => {
    localStorage.setItem(STORAGE_KEY, 'opened')
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="android-app-banner" role="dialog" aria-labelledby="android-app-banner-title">
      <div className="android-app-banner__inner">
        <div className="android-app-banner__text">
          <strong id="android-app-banner-title">{t('androidApp.title')}</strong>
          <p>{t('androidApp.body')}</p>
        </div>
        <div className="android-app-banner__actions">
          <button type="button" className="android-app-banner__btn android-app-banner__btn--secondary" onClick={dismiss}>
            {t('androidApp.dismiss')}
          </button>
          <a
            className="android-app-banner__btn android-app-banner__btn--primary"
            href={PLAY_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={open}
          >
            {t('androidApp.open')}
          </a>
        </div>
      </div>
    </div>
  )
}
