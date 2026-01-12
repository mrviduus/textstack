import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Layout } from './components/Layout'
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
import { SitesPage } from './pages/SitesPage'
import { NotFoundPage } from './pages/NotFoundPage'
import './styles/admin.css'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
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
          <Route path="sites" element={<SitesPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
