import { useState, useEffect, FormEvent } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useTranslation } from '../../hooks/useTranslation'
import { forgotPassword } from '../../api/auth'
import '../../styles/auth.css'

type View = 'login' | 'register' | 'forgot' | 'forgot-sent'

export function AuthModal() {
  const { showAuthModal, authModalView, closeAuthModal, loginWithEmail, registerWithEmail, googleReady, isGuest } = useAuth()
  const { t } = useTranslation()
  const [view, setView] = useState<View>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Open on the tab the caller asked for (e.g. guest "Create free account" → register).
  useEffect(() => {
    if (showAuthModal) setView(authModalView)
  }, [showAuthModal, authModalView])

  if (!showAuthModal) return null

  const reset = () => { setEmail(''); setPassword(''); setName(''); setError('') }
  const switchView = (v: View) => { reset(); setView(v) }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (view === 'register' && password.length < 8) {
      setError('Password must be at least 8 characters.'); return
    }
    setLoading(true)
    try {
      if (view === 'forgot') {
        await forgotPassword(email)
        setView('forgot-sent')
      } else if (view === 'register') {
        await registerWithEmail(email, password, name || undefined)
      } else {
        await loginWithEmail(email, password)
      }
    } catch (err: any) {
      setError(err.message || 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => { reset(); setView('login'); closeAuthModal() }

  return (
    <div className="auth-overlay" onClick={handleClose}>
      <div className="auth-modal" onClick={e => e.stopPropagation()}>
        <button className="auth-modal__close" onClick={handleClose}>&times;</button>

        {view === 'forgot-sent' ? (
          <div className="auth-modal__body">
            <h2 className="auth-modal__title">Check your email</h2>
            <p className="auth-modal__text">
              If an account exists for <strong>{email}</strong>, we sent a password reset link.
            </p>
            <button className="auth-modal__btn" onClick={() => switchView('login')}>
              Back to login
            </button>
          </div>
        ) : view === 'forgot' ? (
          <div className="auth-modal__body">
            <h2 className="auth-modal__title">Reset password</h2>
            <form onSubmit={handleSubmit}>
              <input
                type="email" className="auth-modal__input" placeholder="Email"
                value={email} onChange={e => setEmail(e.target.value)} required autoFocus
              />
              {error && <p className="auth-modal__error">{error}</p>}
              <button className="auth-modal__btn" type="submit" disabled={loading}>
                {loading ? 'Sending...' : 'Send reset link'}
              </button>
            </form>
            <button className="auth-modal__link" onClick={() => switchView('login')}>
              Back to login
            </button>
          </div>
        ) : (
          <div className="auth-modal__body">
            <div className="auth-modal__tabs">
              <button
                className={`auth-modal__tab ${view === 'login' ? 'auth-modal__tab--active' : ''}`}
                onClick={() => switchView('login')}
              >Login</button>
              <button
                className={`auth-modal__tab ${view === 'register' ? 'auth-modal__tab--active' : ''}`}
                onClick={() => switchView('register')}
              >Register</button>
            </div>

            {isGuest && <p className="auth-modal__text">{t('guest.loginSubtitle')}</p>}

            <form onSubmit={handleSubmit}>
              {view === 'register' && (
                <input
                  type="text" className="auth-modal__input" placeholder="Name (optional)"
                  value={name} onChange={e => setName(e.target.value)} autoFocus
                />
              )}
              <input
                type="email" className="auth-modal__input" placeholder="Email"
                value={email} onChange={e => setEmail(e.target.value)} required
                autoFocus={view === 'login'}
              />
              <input
                type="password" className="auth-modal__input" placeholder="Password"
                value={password} onChange={e => setPassword(e.target.value)} required
                minLength={8}
              />
              {error && <p className="auth-modal__error">{error}</p>}
              {error && view === 'register' && (
                // Any register error — incl. an email already taken, which the server words as
                // "invalid email or password" — gets a way to sign in. Keeps the typed email.
                <button type="button" className="auth-modal__link" onClick={() => { setError(''); setPassword(''); setView('login') }}>
                  {t('guest.haveAccount')}
                </button>
              )}
              <button className="auth-modal__btn" type="submit" disabled={loading}>
                {loading ? 'Please wait...' : view === 'login' ? 'Sign in' : 'Create account'}
              </button>
            </form>

            {view === 'login' && (
              <button className="auth-modal__link" onClick={() => switchView('forgot')}>
                Forgot password?
              </button>
            )}

            {googleReady && (
              <>
                <div className="auth-modal__divider"><span>or</span></div>
                <GoogleButtonInModal />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function GoogleButtonInModal() {
  const ref = (el: HTMLDivElement | null) => {
    if (!el || el.hasChildNodes()) return
    if (typeof google !== 'undefined' && google.accounts?.id) {
      google.accounts.id.renderButton(el, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        width: 300,
        text: 'continue_with',
      })
    }
  }
  return <div ref={ref} className="auth-modal__google" />
}
