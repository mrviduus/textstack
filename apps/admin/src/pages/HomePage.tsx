import { useNavigate } from 'react-router-dom'
import { useAdminAuth } from '../context/AdminAuthContext'

export function HomePage() {
  const navigate = useNavigate()
  const { user, logout } = useAdminAuth()

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <main className="home">
      <p>Nothing to manage yet.</p>
      {user && <p>{user.email}</p>}
      <button onClick={handleLogout} className="home__logout">
        Logout
      </button>
    </main>
  )
}
