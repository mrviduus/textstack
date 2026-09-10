import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import { SiteProvider, useSite } from './context/SiteContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import { LanguageProvider, isValidLanguage } from './context/LanguageContext'
import { DownloadProvider } from './context/DownloadContext'
import { GuestLimitsProvider } from './context/GuestLimitsContext'
import { NativeLanguageProvider } from './context/NativeLanguageContext'
// SEO-critical / SSG-prerendered pages — keep eager so SSG renders without Suspense fallback.
import { HomePage } from './pages/HomePage'
import { BooksPage } from './pages/BooksPage'
import { BookDetailPage } from './pages/BookDetailPage'
import { SearchPage } from './pages/SearchPage'
import { AuthorsPage } from './pages/AuthorsPage'
import { AuthorDetailPage } from './pages/AuthorDetailPage'
import { GenresPage } from './pages/GenresPage'
import { GenreDetailPage } from './pages/GenreDetailPage'
import { AboutPage } from './pages/AboutPage'
import { PrivacyPage } from './pages/PrivacyPage'
import { TermsPage } from './pages/TermsPage'
import { DmcaPage } from './pages/DmcaPage'
import { DeleteAccountPage } from './pages/DeleteAccountPage'
import { ContactPage } from './pages/ContactPage'
import { McpLandingPage } from './pages/McpLandingPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { DeviceVerifyPage } from './pages/DeviceVerifyPage'
import { SitemapPage } from './pages/SitemapPage'
import { NotFoundPage } from './pages/NotFoundPage'
// User-only / heavy routes — lazy so they ship in separate chunks.
const ReaderPage = lazy(() => import('./pages/ReaderPage').then(m => ({ default: m.ReaderPage })))
const LibraryPage = lazy(() => import('./pages/LibraryPage').then(m => ({ default: m.LibraryPage })))
const LibraryShelfPage = lazy(() => import('./pages/LibraryShelfPage').then(m => ({ default: m.LibraryShelfPage })))
const UserBookDetailPage = lazy(() => import('./pages/UserBookDetailPage').then(m => ({ default: m.UserBookDetailPage })))
const StatsPage = lazy(() => import('./pages/StatsPage').then(m => ({ default: m.StatsPage })))
const VocabularyPage = lazy(() => import('./pages/VocabularyPage').then(m => ({ default: m.VocabularyPage })))
const VocabularyReviewPage = lazy(() => import('./pages/VocabularyReviewPage').then(m => ({ default: m.VocabularyReviewPage })))
const TutorSessionPage = lazy(() => import('./pages/TutorSessionPage').then(m => ({ default: m.TutorSessionPage })))
const HighlightsPage = lazy(() => import('./pages/HighlightsPage').then(m => ({ default: m.HighlightsPage })))
const HighlightReviewPage = lazy(() => import('./pages/HighlightReviewPage').then(m => ({ default: m.HighlightReviewPage })))
import { Header } from './components/Header'
import { DownloadProgressBar } from './components/DownloadProgressBar'
import { AuthModal } from './components/auth/AuthModal'
import { CookieBanner } from './components/CookieBanner'
import { AndroidTesterBanner } from './components/AndroidTesterBanner'
import { Toast } from './components/Toast'
import { GlobalDropZone } from './components/library/GlobalDropZone'
import { CommandPaletteProvider } from './components/CommandPaletteProvider'
import { useTranslation } from './hooks/useTranslation'
import './styles/theme.css'
import './styles/reader.css'
import './styles/books.css'
import './styles/stats.css'
import './styles/vocabulary.css'
import './styles/highlights.css'
import './styles/auth.css'
import './styles/profile.css'
import './styles/dropzone.css'
import './styles/podcast-player.css'

function AuthSuccessToast() {
  const { authSuccessToast, dismissAuthSuccessToast } = useAuth()
  const { t } = useTranslation()
  if (!authSuccessToast) return null
  return <Toast message={t('auth.progressSavedToast')} duration={4000} onClose={dismissAuthSuccessToast} />
}

function LanguageRoutes() {
  const { lang } = useParams<{ lang: string }>()
  const location = useLocation()

  // Validate language parameter
  if (!isValidLanguage(lang)) {
    return <Navigate to="/en" replace />
  }

  // Hide header on reader pages (have their own top bar)
  const isReaderPage = /^\/[a-z]{2}\/books\/[^/]+\/[^/]+$/.test(location.pathname)
  const isUserBookReaderPage = /^\/[a-z]{2}\/library\/my\/[^/]+\/read(\/[^/]+)?$/.test(location.pathname)

  return (
    <LanguageProvider>
      {!isReaderPage && !isUserBookReaderPage && <Header />}
      <AuthSuccessToast />
      {!isReaderPage && !isUserBookReaderPage && <GlobalDropZone />}
      <CommandPaletteProvider />
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/books" element={<BooksPage />} />
          <Route path="/books/:bookSlug" element={<BookDetailPage />} />
          <Route path="/books/:bookSlug/:chapterSlug" element={<ReaderPage />} />
          <Route path="/authors" element={<AuthorsPage />} />
          <Route path="/authors/:slug" element={<AuthorDetailPage />} />
          <Route path="/genres" element={<GenresPage />} />
          <Route path="/genres/:slug" element={<GenreDetailPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/dmca" element={<DmcaPage />} />
          <Route path="/delete-account" element={<DeleteAccountPage />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/mcp" element={<McpLandingPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/library/shelf/:shelfId" element={<LibraryShelfPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/vocabulary" element={<VocabularyPage />} />
          <Route path="/vocabulary/review" element={<VocabularyReviewPage />} />
          <Route path="/vocabulary/tutor" element={<TutorSessionPage />} />
          <Route path="/highlights" element={<HighlightsPage />} />
          <Route path="/highlights/review" element={<HighlightReviewPage />} />
          <Route path="/library/my/:id" element={<UserBookDetailPage />} />
          {/* Chapterless Original-layout route — a PDF opens instantly here before
              extraction produces chapters (ADR-012). */}
          <Route path="/library/my/:id/read" element={<ReaderPage mode="userbook" />} />
          <Route path="/library/my/:id/read/:chapterSlug" element={<ReaderPage mode="userbook" />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/sitemap" element={<SitemapPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </LanguageProvider>
  )
}

function RootRedirect() {
  const { site } = useSite()
  const defaultLang = site?.defaultLanguage || 'en'
  return <Navigate to={`/${defaultLang}`} replace />
}

// Redirect non-language-prefixed URLs to language-prefixed versions
function LegacyRedirect() {
  const { site } = useSite()
  const location = useLocation()
  const defaultLang = site?.defaultLanguage || 'en'
  return <Navigate to={`/${defaultLang}${location.pathname}${location.search}`} replace />
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      {/* Device Authorization Grant consent (AI-050a) — MCP CLI points here at a
          fixed, language-less URL (/device?code=XXXX-XXXX), so mount top-level. */}
      <Route path="/device" element={<DeviceVerifyPage />} />
      {/* "Send to TextStack" browser extension authorization (Phase 2) — reuses
          the same device flow as /device, only the copy differs. The extension
          hardcodes this stable, language-less URL (/connect-extension?code=…). */}
      <Route path="/connect-extension" element={<DeviceVerifyPage audience="extension" />} />
      {/* Redirect legacy URLs without language prefix */}
      <Route path="/books/*" element={<LegacyRedirect />} />
      <Route path="/authors/*" element={<LegacyRedirect />} />
      <Route path="/genres/*" element={<LegacyRedirect />} />
      <Route path="/search" element={<LegacyRedirect />} />
      <Route path="/about" element={<LegacyRedirect />} />
      <Route path="/privacy" element={<LegacyRedirect />} />
      <Route path="/terms" element={<LegacyRedirect />} />
      <Route path="/dmca" element={<LegacyRedirect />} />
      <Route path="/delete-account" element={<LegacyRedirect />} />
      <Route path="/contact" element={<LegacyRedirect />} />
      <Route path="/library" element={<LegacyRedirect />} />
      <Route path="/stats" element={<LegacyRedirect />} />
      <Route path="/vocabulary" element={<LegacyRedirect />} />
      <Route path="/vocabulary/review" element={<LegacyRedirect />} />
      <Route path="/vocabulary/tutor" element={<LegacyRedirect />} />
      <Route path="/highlights" element={<LegacyRedirect />} />
      <Route path="/highlights/review" element={<LegacyRedirect />} />
      <Route path="/:lang/*" element={<LanguageRoutes />} />
    </Routes>
  )
}

function App() {
  return (
    <BrowserRouter>
      <SiteProvider>
        <AuthProvider>
          <GuestLimitsProvider>
          <NativeLanguageProvider>
          <DownloadProvider>
            <AppRoutes />
            <DownloadProgressBar />
          </DownloadProvider>
          </NativeLanguageProvider>
          </GuestLimitsProvider>
          <AuthModal />
          <CookieBanner />
          <AndroidTesterBanner />
        </AuthProvider>
      </SiteProvider>
    </BrowserRouter>
  )
}

export default App
