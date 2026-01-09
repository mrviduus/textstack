import { LocalizedLink } from './LocalizedLink'
import { useLanguage, SupportedLanguage } from '../context/LanguageContext'

interface Props {
  availableEditions?: { slug: string; language: string; title: string }[]
}

const LANG_NAMES: Record<SupportedLanguage, string> = {
  en: 'English',
  uk: 'Ukrainian',
  ru: 'Russian',
}

export function TranslationNotAvailable({ availableEditions }: Props) {
  const { language, switchLanguage } = useLanguage()

  return (
    <div className="translation-not-available">
      <h1>Translation Not Available</h1>
      <p>
        This book is not available in {LANG_NAMES[language]}.
      </p>

      {availableEditions && availableEditions.length > 0 && (
        <div className="translation-not-available__alternatives">
          <p>Available in:</p>
          <ul>
            {availableEditions.map((ed) => (
              <li key={ed.slug}>
                <a
                  href={`/${ed.language}/books/${ed.slug}`}
                  onClick={(e) => {
                    e.preventDefault()
                    if (ed.language === 'en' || ed.language === 'uk' || ed.language === 'ru') {
                      switchLanguage(ed.language)
                    }
                  }}
                >
                  {ed.title} ({ed.language.toUpperCase()})
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <LocalizedLink to="/books" className="translation-not-available__back">
        Browse all books
      </LocalizedLink>
    </div>
  )
}
