import { useState, FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { platform } from '../platform'
import { useAuth } from '../context/AuthContext'

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const { openAuthModal } = useAuth()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setLoading(true)
    try {
      await platform.account.resetPassword(token, password)
      setSuccess(true)
    } catch (err: any) {
      setError(err.message || 'Reset failed.')
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div className="auth-page">
        <div className="auth-page__card">
          <h2 className="auth-modal__title">Invalid link</h2>
          <p className="auth-modal__text">This reset link is invalid or has expired.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <div className="auth-page__card">
        {success ? (
          <>
            <h2 className="auth-modal__title">Password reset</h2>
            <p className="auth-modal__text">Your password has been updated. You can now sign in.</p>
            <button className="auth-modal__btn" onClick={openAuthModal}>Sign in</button>
          </>
        ) : (
          <>
            <h2 className="auth-modal__title">Set new password</h2>
            <form onSubmit={handleSubmit}>
              <input
                type="password"
                className="auth-modal__input"
                placeholder="New password (min 8 characters)"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
                autoFocus
              />
              {error && <p className="auth-modal__error">{error}</p>}
              <button className="auth-modal__btn" type="submit" disabled={loading}>
                {loading ? 'Resetting...' : 'Reset password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
