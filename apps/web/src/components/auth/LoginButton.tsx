import { useAuth } from '../../context/AuthContext'

export function LoginButton() {
  const { isLoading, openAuthModal } = useAuth()

  if (isLoading) {
    return null
  }

  return (
    <button className="site-header__icon-btn site-header__login-btn" onClick={openAuthModal} aria-label="Sign in">
      <span className="material-icons-outlined">person</span>
    </button>
  )
}
