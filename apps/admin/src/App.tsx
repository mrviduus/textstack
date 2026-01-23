import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AdminAuthProvider } from './context/AdminAuthContext'
import { ProtectedRoute } from './components/ProtectedRoute'
import { Layout } from './components/Layout'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { UploadPage } from './pages/UploadPage'
import { JobsPage } from './pages/JobsPage'
import { EditionsPage } from './pages/EditionsPage'
import { EditEditionPage } from './pages/EditEditionPage'
import { AuthorsPage } from './pages/AuthorsPage'
import { CreateAuthorPage } from './pages/CreateAuthorPage'
import { EditAuthorPage } from './pages/EditAuthorPage'
import { GenresPage } from './pages/GenresPage'
import { CreateGenrePage } from './pages/CreateGenrePage'
import { EditGenrePage } from './pages/EditGenrePage'
import { EditChapterPage } from './pages/EditChapterPage'
import { ToolsPage } from './pages/ToolsPage'
import { SeoCrawlPage } from './pages/SeoCrawlPage'
import { SeoCrawlJobPage } from './pages/SeoCrawlJobPage'
import { SsgRebuildPage } from './pages/SsgRebuildPage'
import { SsgRebuildJobPage } from './pages/SsgRebuildJobPage'
import { NotFoundPage } from './pages/NotFoundPage'
import './styles/admin.css'

function App() {
  return (
    <BrowserRouter>
      <AdminAuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="upload" element={<UploadPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="editions" element={<EditionsPage />} />
            <Route path="editions/:id" element={<EditEditionPage />} />
            <Route path="chapters/:id" element={<EditChapterPage />} />
            <Route path="authors" element={<AuthorsPage />} />
            <Route path="authors/new" element={<CreateAuthorPage />} />
            <Route path="authors/:id" element={<EditAuthorPage />} />
            <Route path="genres" element={<GenresPage />} />
            <Route path="genres/new" element={<CreateGenrePage />} />
            <Route path="genres/:id" element={<EditGenrePage />} />
            <Route path="tools" element={<ToolsPage />} />
            <Route path="seo-crawl" element={<SeoCrawlPage />} />
            <Route path="seo-crawl/:id" element={<SeoCrawlJobPage />} />
            <Route path="ssg-rebuild" element={<SsgRebuildPage />} />
            <Route path="ssg-rebuild/:id" element={<SsgRebuildJobPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AdminAuthProvider>
    </BrowserRouter>
  )
}

export default App
