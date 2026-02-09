import { LocalizedLink } from './LocalizedLink'
import { useTranslation } from '../hooks/useTranslation'

export function Footer() {
  const { t } = useTranslation()

  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="site-footer__description">
          {t('footer.description')}
        </p>
        <nav className="site-footer__links">
          <LocalizedLink to="/privacy" className="site-footer__link">{t('footer.privacy')}</LocalizedLink>
          <LocalizedLink to="/terms" className="site-footer__link">{t('footer.terms')}</LocalizedLink>
          <LocalizedLink to="/contact" className="site-footer__link">{t('footer.contact')}</LocalizedLink>
        </nav>
        <div className="site-footer__bottom">
          <span className="site-footer__logo">TextStack</span>
          <span className="site-footer__copyright">&copy; {new Date().getFullYear()} TextStack Library Project.</span>
        </div>
      </div>
    </footer>
  )
}
