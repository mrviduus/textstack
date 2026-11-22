import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { LanguageProvider, isValidLanguage } from './context/LanguageContext'
import { GuestLimitsProvider } from './context/GuestLimitsContext'
import { NativeLanguageProvider } from './context/NativeLanguageContext'
// Static pages: eager.
import { HomePage } from './pages/HomePage'
import { AboutPage } from './pages/AboutPage'
import { PrivacyPage } from './pages/PrivacyPage'
import { TermsPage } from './pages/TermsPage'
import { DmcaPage } from './pages/DmcaPage'
import { DeleteAccountPage } from './pages/DeleteAccountPage'
import { ContactPage } from './pages/ContactPage'
import { McpLandingPage } from './pages/McpLandingPage'
import { OAuthConsentPage } from './pages/OAuthConsentPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { DeviceVerifyPage } from './pages/DeviceVerifyPage'
import { ChangelogPage } from './pages/ChangelogPage'
import { NotFoundPage } from './pages/NotFoundPage'
// User-only / heavy routes — lazy so they ship in separate chunks.
const ReaderPage = lazy(() => import('./pages/ReaderPage').then(m => ({ default: m.ReaderPage })))
const LibraryPage = lazy(() => import('./pages/LibraryPage').then(m => ({ default: m.LibraryPage })))
const UserBookDetailPage = lazy(() => import('./pages/UserBookDetailPage').then(m => ({ default: m.UserBookDetailPage })))
const VocabularyPage = lazy(() => import('./pages/VocabularyPage').then(m => ({ default: m.VocabularyPage })))
const VocabularyReviewPage = lazy(() => import('./pages/VocabularyReviewPage').then(m => ({ default: m.VocabularyReviewPage })))
const HighlightsPage = lazy(() => import('./pages/HighlightsPage').then(m => ({ default: m.HighlightsPage })))
import { Header } from './components/Header'
import { AuthModal } from './components/auth/AuthModal'
import { CookieBanner } from './components/CookieBanner'
import { AndroidAppBanner } from './components/AndroidAppBanner'
import { Toast } from './components/Toast'
import { GlobalDropZone } from './components/library/GlobalDropZone'
import { CommandPaletteProvider } from './components/CommandPaletteProvider'
import { useTranslation } from './hooks/useTranslation'
import './styles/theme.css'
import './styles/reader.css'
import './styles/books.css'
import './styles/vocabulary.css'
import './styles/highlights.css'
import './styles/chapter-review.css'
import './styles/auth.css'
import './styles/profile.css'
import './styles/dropzone.css'

function AuthSuccessToast() {
  const { authSuccessToast, dismissAuthSuccessToast } = useAuth()
  const { t } = useTranslation()
  if (!authSuccessToast) return null
  const message = authSuccessToast === 'merged' ? t('guest.merged') : t('auth.progressSavedToast')
  return <Toast message={message} duration={4000} onClose={dismissAuthSuccessToast} />
}

/**
 * The other half of the sentence above.
 *
 * The server has reported a skipped guest merge since guest sessions shipped, and no client read it
 * — so a reader whose highlights and progress did NOT come across was shown "your progress was
 * kept" all the same. The two are mutually exclusive in AuthContext; this one is deliberately the
 * slower read, because it is the one that asks the reader to notice something.
 */
function GuestMergeSkippedToast() {
  const { guestMergeSkipped, dismissGuestMergeSkipped } = useAuth()
  const { t } = useTranslation()
  if (!guestMergeSkipped) return null
  return (
    <Toast
      message={t('guest.progressNotCarried')}
      duration={9000}
      onClose={dismissGuestMergeSkipped}
    />
  )
}

function LanguageRoutes() {
  const { lang } = useParams<{ lang: string }>()
  const location = useLocation()

  // Validate language parameter
  if (!isValidLanguage(lang)) {
    return <Navigate to="/en" replace />
  }

  // Hide header on reader pages (have their own top bar)
  const isUserBookReaderPage = /^\/[a-z]{2}\/library\/my\/[^/]+\/(read(\/[^/]+)?|read-v2\/?)$/.test(location.pathname)

  return (
    <LanguageProvider>
      {!isUserBookReaderPage && <Header />}
      <AuthSuccessToast />
      <GuestMergeSkippedToast />
      {!isUserBookReaderPage && <GlobalDropZone />}
      <CommandPaletteProvider />
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/dmca" element={<DmcaPage />} />
          <Route path="/delete-account" element={<DeleteAccountPage />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/mcp" element={<McpLandingPage />} />
          {/* OAuth consent (ADR-017): /oauth/authorize 302s here. Not in /ssg/routes, noindex. */}
          <Route path="/oauth/consent" element={<OAuthConsentPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/vocabulary" element={<VocabularyPage />} />
          <Route path="/vocabulary/review" element={<VocabularyReviewPage />} />
          <Route path="/highlights" element={<HighlightsPage />} />
          <Route path="/library/my/:id" element={<UserBookDetailPage />} />
          {/* The V2 reader. The chapter slug (old links) is ignored: the book opens at its synced place. /read-v2: an alias. */}
          <Route path="/library/my/:id/read" element={<ReaderPage />} />
          <Route path="/library/my/:id/read/:chapterSlug" element={<ReaderPage />} />
          <Route path="/library/my/:id/read-v2" element={<ReaderPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/changelog" element={<ChangelogPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </LanguageProvider>
  )
}

// Redirect non-language-prefixed URLs to language-prefixed versions
function LegacyRedirect() {
  const location = useLocation()
  return <Navigate to={`/en${location.pathname}${location.search}`} replace />
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/en" replace />} />
      {/* Device Authorization Grant consent (AI-050a) — MCP CLI points here at a
          fixed, language-less URL (/device?code=XXXX-XXXX), so mount top-level. */}
      <Route path="/device" element={<DeviceVerifyPage />} />
      {/* "Send to TextStack" browser extension authorization (Phase 2) — reuses
          the same device flow as /device, only the copy differs. The extension
          hardcodes this stable, language-less URL (/connect-extension?code=…). */}
      <Route path="/connect-extension" element={<DeviceVerifyPage audience="extension" />} />
      {/* Redirect legacy URLs without language prefix */}
      <Route path="/about" element={<LegacyRedirect />} />
      <Route path="/privacy" element={<LegacyRedirect />} />
      <Route path="/terms" element={<LegacyRedirect />} />
      <Route path="/dmca" element={<LegacyRedirect />} />
      <Route path="/delete-account" element={<LegacyRedirect />} />
      <Route path="/contact" element={<LegacyRedirect />} />
      <Route path="/changelog" element={<LegacyRedirect />} />
      <Route path="/library" element={<LegacyRedirect />} />
      <Route path="/vocabulary" element={<LegacyRedirect />} />
      <Route path="/vocabulary/review" element={<LegacyRedirect />} />
      <Route path="/highlights" element={<LegacyRedirect />} />
      <Route path="/:lang/*" element={<LanguageRoutes />} />
    </Routes>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <GuestLimitsProvider>
          <NativeLanguageProvider>
            <AppRoutes />
          </NativeLanguageProvider>
        </GuestLimitsProvider>
        <AuthModal />
        <CookieBanner />
        <AndroidAppBanner />
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
