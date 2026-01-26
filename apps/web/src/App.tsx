import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import { SiteProvider, useSite } from './context/SiteContext'
import { AuthProvider } from './context/AuthContext'
import { LanguageProvider, isValidLanguage } from './context/LanguageContext'
import { DownloadProvider } from './context/DownloadContext'
import { HomePage } from './pages/HomePage'
import { ReaderPage } from './pages/ReaderPage'
import { BooksPage } from './pages/BooksPage'
import { BookDetailPage } from './pages/BookDetailPage'
import { SearchPage } from './pages/SearchPage'
import { AuthorsPage } from './pages/AuthorsPage'
import { AuthorDetailPage } from './pages/AuthorDetailPage'
import { GenresPage } from './pages/GenresPage'
import { GenreDetailPage } from './pages/GenreDetailPage'
import { AboutPage } from './pages/AboutPage'
import { LibraryPage } from './pages/LibraryPage'
import { UserBookDetailPage } from './pages/UserBookDetailPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { Header } from './components/Header'
import { DownloadProgressBar } from './components/DownloadProgressBar'
import './styles/theme.css'
import './styles/reader.css'
import './styles/books.css'

function LanguageRoutes() {
  const { lang } = useParams<{ lang: string }>()
  const location = useLocation()

  // Validate language parameter
  if (!isValidLanguage(lang)) {
    return <Navigate to="/en" replace />
  }

  // Hide header on reader pages (have their own top bar)
  const isReaderPage = /^\/[a-z]{2}\/books\/[^/]+\/[^/]+$/.test(location.pathname)
  const isUserBookReaderPage = /^\/[a-z]{2}\/library\/my\/[^/]+\/read\/\d+$/.test(location.pathname)

  return (
    <LanguageProvider>
      {!isReaderPage && !isUserBookReaderPage && <Header />}
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
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/library/my/:id" element={<UserBookDetailPage />} />
        <Route path="/library/my/:id/read/:chapterNumber" element={<ReaderPage mode="userbook" />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
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
      {/* Redirect legacy URLs without language prefix */}
      <Route path="/books/*" element={<LegacyRedirect />} />
      <Route path="/authors/*" element={<LegacyRedirect />} />
      <Route path="/genres/*" element={<LegacyRedirect />} />
      <Route path="/search" element={<LegacyRedirect />} />
      <Route path="/about" element={<LegacyRedirect />} />
      <Route path="/library" element={<LegacyRedirect />} />
      <Route path="/:lang/*" element={<LanguageRoutes />} />
    </Routes>
  )
}

function App() {
  return (
    <BrowserRouter>
      <SiteProvider>
        <AuthProvider>
          <DownloadProvider>
            <AppRoutes />
            <DownloadProgressBar />
          </DownloadProvider>
        </AuthProvider>
      </SiteProvider>
    </BrowserRouter>
  )
}

export default App
