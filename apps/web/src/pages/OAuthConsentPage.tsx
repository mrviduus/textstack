import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SeoHead } from '../components/SeoHead'
import { LocalizedLink } from '../components/LocalizedLink'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from '../hooks/useTranslation'
import {
  getOAuthRequest,
  approveOAuthRequest,
  denyOAuthRequest,
  type OAuthConsentRequest,
} from '../api/oauth'

/**
 * OAuth consent for the MCP endpoint (ADR-017). `GET /oauth/authorize` 302s here with `?req=<id>`;
 * a signed-in account approves and the browser goes back to the client with a code.
 *
 * Same "approve in a signed-in browser" pattern as DeviceVerifyPage. The sign-in modal keeps the
 * URL, so after signing in the page re-renders into consent with the same `req`. A guest is never
 * sent to approve — the server would 403 `account_required`; registering promotes the guest row in
 * place (ADR-014), so the CTA is the auth modal and the reader's books are kept.
 *
 * The redirect host is always shown: it is the one thing a phishing request cannot fake.
 */

/** Test seam: jsdom cannot navigate. */
export const navigateTo = { go: (url: string) => window.location.assign(url) }

type Load = { kind: 'loading' } | { kind: 'gone' } | { kind: 'ready'; req: OAuthConsentRequest }

export function OAuthConsentPage() {
  const [params] = useSearchParams()
  const requestId = params.get('req') || ''
  const { t } = useTranslation()
  const { user, isLoading, isAuthenticated, isGuest, openAuthModal, logout } = useAuth()

  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [needsAccount, setNeedsAccount] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!requestId) {
      setLoad({ kind: 'gone' })
      return
    }
    let live = true
    getOAuthRequest(requestId)
      .then(req => live && setLoad(req.status === 'pending' ? { kind: 'ready', req } : { kind: 'gone' }))
      .catch(() => live && setLoad({ kind: 'gone' }))
    return () => { live = false }
  }, [requestId])

  const decide = async (approve: boolean) => {
    setBusy(true)
    setError('')
    try {
      const redirect = approve ? await approveOAuthRequest(requestId) : await denyOAuthRequest(requestId)
      setLeaving(true)
      navigateTo.go(redirect)
    } catch (e) {
      const err = e as { status?: number; message?: string }
      if (err.status === 403 && err.message === 'account_required') setNeedsAccount(true)
      else if (err.status === 400 || err.status === 404) setLoad({ kind: 'gone' })
      else if (err.status === 401) openAuthModal()
      else setError(t('oauthConsent.errorGeneric'))
    } finally {
      setBusy(false)
    }
  }

  const switchAccount = async () => {
    await logout()
    openAuthModal()
  }

  const shell = (body: React.ReactNode) => (
    <div className="auth-page">
      <SeoHead title={t('oauthConsent.seoTitle')} noindex />
      <div className="auth-page__card oauth-consent">
        <div className="oauth-consent__logo">
          <img src="/favicon.svg" alt="" width={40} height={40} />
          <span>TextStack</span>
        </div>
        {body}
      </div>
    </div>
  )

  if (load.kind === 'loading' || (load.kind === 'ready' && isLoading)) {
    return shell(<p className="auth-modal__text">{t('oauthConsent.loading')}</p>)
  }

  if (load.kind === 'gone') {
    return shell(
      <>
        <h2 className="auth-modal__title">{t('oauthConsent.expiredTitle')}</h2>
        <p className="auth-modal__text">{t('oauthConsent.expiredText')}</p>
      </>,
    )
  }

  const { req } = load

  if (leaving) {
    return shell(<p className="auth-modal__text">{t('oauthConsent.returning', { host: req.redirectHost })}</p>)
  }

  const cancelBtn = (
    <button type="button" className="auth-modal__btn oauth-consent__cancel" onClick={() => decide(false)} disabled={busy}>
      {t('oauthConsent.cancel')}
    </button>
  )

  const header = (
    <>
      <h2 className="auth-modal__title">{t('oauthConsent.title', { client: req.clientName })}</h2>
      <p className="auth-modal__text oauth-consent__host">
        {t('oauthConsent.returnsTo')} <strong>{req.redirectHost}</strong>
      </p>
    </>
  )

  if (!isAuthenticated) {
    return shell(
      <>
        {header}
        <p className="auth-modal__text">{t('oauthConsent.signInText')}</p>
        <div className="oauth-consent__actions">
          <button type="button" className="auth-modal__btn" onClick={openAuthModal}>
            {t('oauthConsent.signIn')}
          </button>
          {cancelBtn}
        </div>
      </>,
    )
  }

  if (isGuest || needsAccount) {
    return shell(
      <>
        {header}
        <p className="auth-modal__text">{t('oauthConsent.guestText')}</p>
        <div className="oauth-consent__actions">
          <button type="button" className="auth-modal__btn" onClick={openAuthModal}>
            {t('oauthConsent.guestCta')}
          </button>
          {cancelBtn}
        </div>
      </>,
    )
  }

  return shell(
    <>
      <h2 className="auth-modal__title">{t('oauthConsent.title', { client: req.clientName })}</h2>
      <p className="oauth-consent__label">{t('oauthConsent.canLabel')}</p>
      <ul className="oauth-consent__list">
        <li>{t('oauthConsent.canRead')}</li>
        <li>{t('oauthConsent.canWrite')}</li>
      </ul>
      <p className="oauth-consent__cannot">{t('oauthConsent.cannot')}</p>
      <p className="auth-modal__text oauth-consent__who">
        {t('oauthConsent.signedInAs', { email: user?.email || '' })}{' '}
        <button type="button" className="oauth-consent__switch" onClick={switchAccount}>
          ({t('oauthConsent.switch')})
        </button>
      </p>
      <p className="auth-modal__text oauth-consent__host">
        {t('oauthConsent.returnsTo')} <strong>{req.redirectHost}</strong>
      </p>
      {error && <p className="auth-modal__error" role="alert">{error}</p>}
      <div className="oauth-consent__actions">
        <button type="button" className="auth-modal__btn" onClick={() => decide(true)} disabled={busy}>
          {t('oauthConsent.allow')}
        </button>
        {cancelBtn}
      </div>
      <p className="oauth-consent__footnote">
        {t('oauthConsent.disconnectHint')}{' '}
        <LocalizedLink to="/mcp">{t('oauthConsent.connectedApps')}</LocalizedLink>.
      </p>
    </>,
  )
}
