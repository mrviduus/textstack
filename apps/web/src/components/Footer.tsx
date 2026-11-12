import { LocalizedLink } from './LocalizedLink'
import { useTranslation } from '../hooks/useTranslation'
import { PLAY_URL } from './AndroidAppBanner'

// Developer docs live in the repo for now; a docs site comes later (#1237).
const DOCS_URL = 'https://github.com/mrviduus/textstack/blob/main/docs/README.md'

export function Footer() {
  const { t } = useTranslation()

  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="site-footer__description">
          {t('footer.description')}
        </p>
        {/* The footer sits at the bottom, and client-side navigation keeps the scroll: without this
            the new page opens on its own footer (#1245). Links that open a new tab are left alone. */}
        <div
          className="site-footer__columns"
          onClick={(e) => {
            const link = (e.target as HTMLElement).closest('a')
            if (link && link.target !== '_blank') window.scrollTo(0, 0)
          }}
        >
          <nav className="site-footer__col" aria-labelledby="footer-col-read">
            <h2 id="footer-col-read" className="site-footer__heading">{t('footer.colRead')}</h2>
            <LocalizedLink to="/books" className="site-footer__link">{t('nav.catalog')}</LocalizedLink>
            <LocalizedLink to="/authors" className="site-footer__link">{t('footer.authors')}</LocalizedLink>
            <LocalizedLink to="/genres" className="site-footer__link">{t('nav.genres')}</LocalizedLink>
          </nav>
          <nav className="site-footer__col" aria-labelledby="footer-col-app">
            <h2 id="footer-col-app" className="site-footer__heading">{t('footer.colApp')}</h2>
            <a href={PLAY_URL} className="site-footer__link" target="_blank" rel="noopener noreferrer">{t('footer.android')} ↗</a>
            <LocalizedLink to="/mcp" className="site-footer__link">{t('footer.ai')}</LocalizedLink>
            <LocalizedLink to="/changelog" className="site-footer__link">{t('footer.changelog')}</LocalizedLink>
          </nav>
          <nav className="site-footer__col" aria-labelledby="footer-col-project">
            <h2 id="footer-col-project" className="site-footer__heading">{t('footer.colProject')}</h2>
            <LocalizedLink to="/about" className="site-footer__link">{t('footer.about')}</LocalizedLink>
            <LocalizedLink to="/contact" className="site-footer__link">{t('footer.contact')}</LocalizedLink>
            <a href={DOCS_URL} className="site-footer__link" target="_blank" rel="noopener noreferrer">{t('footer.developers')} ↗</a>
          </nav>
          <nav className="site-footer__col" aria-labelledby="footer-col-legal">
            <h2 id="footer-col-legal" className="site-footer__heading">{t('footer.colLegal')}</h2>
            <LocalizedLink to="/privacy" className="site-footer__link">{t('footer.privacy')}</LocalizedLink>
            <LocalizedLink to="/terms" className="site-footer__link">{t('footer.terms')}</LocalizedLink>
            <LocalizedLink to="/dmca" className="site-footer__link">{t('footer.dmca')}</LocalizedLink>
            <LocalizedLink to="/delete-account" className="site-footer__link">{t('footer.deleteAccount')}</LocalizedLink>
            <LocalizedLink to="/sitemap" className="site-footer__link">{t('footer.sitemap')}</LocalizedLink>
          </nav>
        </div>

        {/* Our own badge, not Google's artwork: it follows the light/dark theme. */}
        <div className="site-footer__android">
          <a className="site-footer__android-badge" href={PLAY_URL} target="_blank" rel="noopener noreferrer">
            <svg className="site-footer__android-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M17.6 9.48l1.84-3.18a.4.4 0 0 0-.7-.4l-1.86 3.22a11.4 11.4 0 0 0-9.76 0L5.26 5.9a.4.4 0 1 0-.7.4L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"
              />
            </svg>
            <span className="site-footer__android-text">
              <span className="site-footer__android-label">{t('androidApp.badgeLabel')}</span>
              <span className="site-footer__android-action">{t('androidApp.badgeAction')}</span>
            </span>
          </a>
        </div>

        <div className="site-footer__bottom">
          <span className="site-footer__logo">TextStack</span>
          <span className="site-footer__copyright">&copy; {new Date().getFullYear()} TextStack Reader Library Project.</span>
        </div>
      </div>
    </footer>
  )
}
