import { useState, useRef, useEffect } from 'react'
import { useLanguage, SupportedLanguage } from '../context/LanguageContext'

const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: 'EN',
  uk: 'UA',
  ru: 'RU',
}

export function LanguageSwitcher() {
  const { language, supportedLanguages, switchLanguage } = useLanguage()
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const otherLanguages = supportedLanguages.filter((l) => l !== language)

  return (
    <div className="lang-select" ref={ref}>
      <button
        className="lang-select__trigger"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        {LANGUAGE_LABELS[language]}
        <svg className="lang-select__chevron" viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {isOpen && (
        <ul className="lang-select__menu" role="listbox">
          {otherLanguages.map((lang) => (
            <li key={lang}>
              <button
                className="lang-select__option"
                onClick={() => {
                  switchLanguage(lang as SupportedLanguage)
                  setIsOpen(false)
                }}
                role="option"
              >
                {LANGUAGE_LABELS[lang as SupportedLanguage]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
