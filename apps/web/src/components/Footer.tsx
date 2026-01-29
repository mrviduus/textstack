import { LocalizedLink } from './LocalizedLink'

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="site-footer__description">
          TextStack is an online platform designed for comfortable reading.
          The current catalog features classic literature and public-domain works
          by authors from different eras and traditions. Each book is organized
          into chapters for easy navigation. The platform is built for readers
          who prefer a distraction-free reading experience.
        </p>
        <nav className="site-footer__links">
          <LocalizedLink to="/privacy" className="site-footer__link">Privacy Policy</LocalizedLink>
          <LocalizedLink to="/terms" className="site-footer__link">Terms of Service</LocalizedLink>
          <LocalizedLink to="/contact" className="site-footer__link">Contact Us</LocalizedLink>
        </nav>
        <div className="site-footer__bottom">
          <span className="site-footer__logo">TextStack</span>
          <span className="site-footer__copyright">&copy; {new Date().getFullYear()} TextStack Library Project.</span>
        </div>
      </div>
    </footer>
  )
}
