import { LocalizedLink } from './LocalizedLink'
import { useTranslation } from '../hooks/useTranslation'
import { OPT_IN_URL } from './AndroidTesterBanner'

export function Footer() {
  const { t } = useTranslation()

  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="site-footer__description">
          {t('footer.description')}
        </p>
        <nav className="site-footer__content-links">
          <LocalizedLink to="/books" className="site-footer__link">{t('nav.catalog')}</LocalizedLink>
          <LocalizedLink to="/authors" className="site-footer__link">{t('footer.authors')}</LocalizedLink>
          <LocalizedLink to="/genres" className="site-footer__link">{t('nav.genres')}</LocalizedLink>
        </nav>
        <nav className="site-footer__links">
          <LocalizedLink to="/privacy" className="site-footer__link">{t('footer.privacy')}</LocalizedLink>
          <LocalizedLink to="/terms" className="site-footer__link">{t('footer.terms')}</LocalizedLink>
          <LocalizedLink to="/dmca" className="site-footer__link">{t('footer.dmca')}</LocalizedLink>
          <LocalizedLink to="/delete-account" className="site-footer__link">{t('footer.deleteAccount')}</LocalizedLink>
          <LocalizedLink to="/contact" className="site-footer__link">{t('footer.contact')}</LocalizedLink>
          <LocalizedLink to="/sitemap" className="site-footer__link">{t('footer.sitemap')}</LocalizedLink>
          <LocalizedLink to="/changelog" className="site-footer__link">{t('footer.changelog')}</LocalizedLink>
        </nav>
        {/* Deliberately not the official "Get it on Google Play" badge. That badge
            links to a store listing, and ours returns 404 while the app is in
            closed testing — so it would send every visitor to a Not Found page
            and misrepresent a beta as a shipped app. Swap it in the day the
            production track goes live; the link is the only thing that changes.

            Shown to everyone, unlike AndroidTesterBanner, which waits for an
            Android device and a reader who has actually opened a book. This is
            the standing "we have an app" line; that one is the invitation. */}
        <div className="site-footer__android">
          <a
            className="site-footer__android-badge"
            href={OPT_IN_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg className="site-footer__android-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M17.6 9.48l1.84-3.18a.4.4 0 0 0-.7-.4l-1.86 3.22a11.4 11.4 0 0 0-9.76 0L5.26 5.9a.4.4 0 1 0-.7.4L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"
              />
            </svg>
            <span className="site-footer__android-text">
              <span className="site-footer__android-label">{t('androidBeta.badgeLabel')}</span>
              <span className="site-footer__android-action">{t('androidBeta.badgeAction')}</span>
            </span>
          </a>
          <p className="site-footer__android-note">{t('androidBeta.badgeNote')}</p>
        </div>

        <div className="site-footer__bottom">
          <span className="site-footer__logo">TextStack</span>
          <span className="site-footer__copyright">&copy; {new Date().getFullYear()} TextStack Reader Library Project.</span>
        </div>
      </div>
    </footer>
  )
}
