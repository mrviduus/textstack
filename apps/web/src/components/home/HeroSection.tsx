import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from '../../hooks/useTranslation'
import { useLanguage } from '../../context/LanguageContext'
import { useNativeLanguage } from '../../context/NativeLanguageContext'
import { useAuth } from '../../context/AuthContext'
import { useGuestLimits } from '../../context/GuestLimitsContext'
import { DEMO_BOOK } from '../../config/demoBook'
import { MobileSearchOverlay } from '../Search'
import { LocalizedLink } from '../LocalizedLink'
import { uploadUserBook } from '../../api/userBooks'
import { pdfFilePassesSanityCheck } from '../../lib/pdfUploadSanity'
import { useContinueReading } from '../../hooks/useContinueReading'
import { ContinueReadingCard } from './ContinueReadingCard'
import { POPULAR_LANGUAGES, getLanguage } from '@textstack/shared'
import { getFlagUrl } from '../../data/flags'

export function HeroSection() {
  const { t } = useTranslation()
  const { language } = useLanguage()
  const { isAuthenticated, ensureSession } = useAuth()
  const { isReturningUser, guestState } = useGuestLimits()
  const { book: continueReadingBook } = useContinueReading()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [isMobile, setIsMobile] = useState(false)
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [langPickerOpen, setLangPickerOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const langTriggerRef = useRef<HTMLDivElement>(null)
  const { nativeLanguage, setNativeLanguage, hasConfirmedLanguage } = useNativeLanguage()
  const nativeLang = getLanguage(nativeLanguage)
  const isCollision = nativeLanguage === language
  const showPulse = !hasConfirmedLanguage || isCollision

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Close lang picker on outside click
  useEffect(() => {
    if (!langPickerOpen) return
    const handler = (e: MouseEvent) => {
      if (langTriggerRef.current && !langTriggerRef.current.contains(e.target as Node)) {
        setLangPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [langPickerOpen])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim()) {
      navigate(`/${language}/search?q=${encodeURIComponent(query.trim())}`)
    }
  }

  const handleInputFocus = () => {
    if (isMobile) {
      setSearchOverlayOpen(true)
    }
  }

  const handleUpload = async (file: File) => {
    if (uploading) return
    setUploadError(null)
    // Pre-upload sanity check: block a truncated PDF (picked mid-download)
    // before spending the upload. Server also 400s it.
    if (!(await pdfFilePassesSanityCheck(file))) {
      setUploadError(t('upload.dropzone.truncatedPdf'))
      return
    }
    setUploading(true)
    try {
      await ensureSession()
      const result = await uploadUserBook(file)
      navigate(`/${language}/library/my/${result.userBookId}`)
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleUpload(file)
    e.target.value = ''
  }

  const showGuestCta = !isAuthenticated
  const demoPath = `/books/${DEMO_BOOK.bookSlug}/${DEMO_BOOK.chapterSlug}`
  const returningPath = guestState.currentBook
    ? `/books/${guestState.currentBook.bookSlug}/${guestState.currentBook.chapterSlug}`
    : demoPath

  return (
    <section className="home-hero">
      <div className="home-hero__content">
        {continueReadingBook && <ContinueReadingCard book={continueReadingBook} />}
        <h1 className="home-hero__title">{t('home.hero.title')}</h1>
        <p className="home-hero__subtitle">
          {t('home.hero.subtitleBefore')}{' '}
          <span className="home-hero__lang-trigger-wrap" ref={langTriggerRef}>
            <button
              type="button"
              className={`home-hero__lang-trigger${showPulse ? ' home-hero__lang-trigger--pulse' : ''}`}
              onClick={() => setLangPickerOpen(o => !o)}
            >
              {isCollision ? (
                <>
                  <svg className="home-hero__lang-globe" viewBox="0 0 20 15" fill="none" aria-hidden="true">
                    <circle cx="10" cy="7.5" r="6" stroke="currentColor" strokeWidth="1.2" />
                    <ellipse cx="10" cy="7.5" rx="2.5" ry="6" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M4 7.5h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                  {t('home.hero.yourLanguage')}
                </>
              ) : (
                <>
                  {nativeLang && (
                    <img
                      className="home-hero__lang-flag"
                      src={getFlagUrl(nativeLang.code)}
                      alt=""
                      width="20"
                      height="15"
                    />
                  )}
                  {nativeLang?.nativeName ?? nativeLanguage}
                </>
              )}
            </button>
            {langPickerOpen && (
              <div className="home-hero__lang-popover">
                <ul className="home-hero__lang-list" role="listbox">
                  {POPULAR_LANGUAGES.filter(l => l.code !== language).map(l => (
                    <li
                      key={l.code}
                      role="option"
                      aria-selected={l.code === nativeLanguage}
                      className={`home-hero__lang-option${l.code === nativeLanguage ? ' selected' : ''}`}
                      onClick={() => { setNativeLanguage(l.code); setLangPickerOpen(false) }}
                    >
                      <img src={getFlagUrl(l.code)} alt="" width="20" height="15" />
                      <span>{l.nativeName}</span>
                      {l.englishName !== l.nativeName && (
                        <span className="home-hero__lang-english">{l.englishName}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </span>{' '}
          {t('home.hero.subtitleAfter')}
        </p>
        <p className="home-hero__brand-line">{t('home.hero.brandLine')}</p>

        {showGuestCta && (
          <div className="home-hero__cta-group">
            <LocalizedLink
              to={isReturningUser ? returningPath : demoPath}
              className={`home-hero__cta-primary${!isReturningUser ? ' home-hero__cta-primary--pulse' : ''}`}
            >
              {isReturningUser ? t('home.hero.ctaReturning') : t('home.hero.ctaPrimary')}
            </LocalizedLink>
            {uploading ? (
              <span className="home-hero__cta-secondary" style={{ opacity: 0.7 }}>
                <span className="material-icons-outlined" style={{ fontSize: 18, marginRight: 4 }}>hourglass_empty</span>
                {t('guest.uploading')}
              </span>
            ) : (
              <button
                type="button"
                className="home-hero__cta-secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="material-icons-outlined" style={{ fontSize: 18, marginRight: 4 }}>upload_file</span>
                {t('guest.uploadBook')}
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".epub,.pdf"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            {uploadError && (
              <p style={{ color: '#c62828', fontSize: 13, margin: '4px 0 0' }}>{uploadError}</p>
            )}
          </div>
        )}

        <form className="home-hero__search" onSubmit={handleSearch}>
          <span className="material-icons-outlined home-hero__search-icon">search</span>
          <input
            type="text"
            className="home-hero__search-input"
            placeholder={t('home.hero.searchPlaceholder') || 'Search by title, author, or genre...'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={handleInputFocus}
            readOnly={isMobile}
          />
        </form>
      </div>

      {searchOverlayOpen && <MobileSearchOverlay onClose={() => setSearchOverlayOpen(false)} />}
    </section>
  )
}
