import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { useLanguage } from '../context/LanguageContext'

export function NotFoundPage() {
  const { language } = useLanguage()

  return (
    <div className="not-found">
      <SeoHead
        title="Page Not Found"
        description="The page you're looking for doesn't exist or has been moved."
        noindex
        statusCode={404}
      />
      <div className="not-found__content">
        <h1>404</h1>
        <p>{language === 'uk' ? 'Сторінку не знайдено' : 'Page not found'}</p>
        <LocalizedLink to="/" className="back-home-link">
          {language === 'uk' ? 'На головну' : 'Back to Home'}
        </LocalizedLink>
      </div>
    </div>
  )
}
