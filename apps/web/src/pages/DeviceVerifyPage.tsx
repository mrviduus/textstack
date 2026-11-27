import { useState, FormEvent, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { DeviceApproveError } from '../api/auth'
import { platform } from '../platform'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from '../hooks/useTranslation'

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) consent gate (AI-050a).
 * The MCP CLI prints a user_code and points the user at /device(?code=XXXX-XXXX).
 * A signed-in TextStack user confirms the code and approves the CLI's access.
 * Mounted at top-level (no /:lang prefix) so the CLI's stable URL works.
 *
 * Reused for the "Send to TextStack" browser extension (Phase 2): the same
 * device flow + logic, only the copy differs. `audience` selects the i18n
 * namespace — 'cli' (default) → deviceVerify.*, 'extension' → connectExtension.*.
 */

export type DeviceVerifyAudience = 'cli' | 'extension'

/** Strip everything but [A-Z0-9], then format as XXXX-XXXX for display. */
function formatUserCode(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  if (clean.length <= 4) return clean
  return `${clean.slice(0, 4)}-${clean.slice(4)}`
}

/** What we send to the backend: trimmed, uppercased; backend normalizes further. */
function normalizeForSubmit(display: string): string {
  return display.trim().toUpperCase()
}

/** Map the thrown auth error (status + message=code) to an i18n key suffix. */
function errorKeySuffix(err: unknown): string {
  const e = err as { status?: number; message?: string }
  if (e?.status === 401) return 'errorNotSignedIn'
  const code = e?.message as DeviceApproveError | undefined
  switch (code) {
    case 'invalid_user_code':
      return 'errorInvalidCode'
    case 'expired_user_code':
      return 'errorExpired'
    case 'user_code_already_used':
      return 'errorAlreadyUsed'
    default:
      return 'errorGeneric'
  }
}

export function DeviceVerifyPage({ audience = 'cli' }: { audience?: DeviceVerifyAudience } = {}) {
  const [params] = useSearchParams()
  const { t } = useTranslation()
  const { isAuthenticated, user, openAuthModal } = useAuth()

  // Copy namespace: CLI/MCP keeps the original deviceVerify.* strings; the
  // browser extension uses the parallel connectExtension.* set.
  const ns = audience === 'extension' ? 'connectExtension' : 'deviceVerify'
  const k = (suffix: string) => `${ns}.${suffix}`

  const initialCode = useMemo(() => formatUserCode(params.get('code') || ''), [params])
  const [code, setCode] = useState(initialCode)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [success, setSuccess] = useState(false)
  const [denied, setDenied] = useState(false)

  const handleApprove = async (e: FormEvent) => {
    e.preventDefault()
    setErrorMsg('')
    const submitCode = normalizeForSubmit(code)
    if (!submitCode) {
      setErrorMsg(t(k('errorInvalidCode')))
      return
    }
    setSubmitting(true)
    try {
      await platform.account.approveDevice(submitCode)
      setSuccess(true)
    } catch (err) {
      setErrorMsg(t(k(errorKeySuffix(err))))
    } finally {
      setSubmitting(false)
    }
  }

  // Deny/Cancel: when authenticated with a code present, actually deny the
  // pending row server-side so the CLI stops polling and gets access_denied.
  // Otherwise (not signed in or no code) there's nothing to deny — local cancel.
  const handleDeny = async () => {
    setErrorMsg('')
    const submitCode = normalizeForSubmit(code)
    if (!isAuthenticated || !submitCode) {
      setDenied(true)
      return
    }
    setSubmitting(true)
    try {
      await platform.account.denyDevice(submitCode)
      setDenied(true)
    } catch (err) {
      setErrorMsg(t(k(errorKeySuffix(err))))
    } finally {
      setSubmitting(false)
    }
  }

  // --- Success ---------------------------------------------------------------
  if (success) {
    return (
      <div className="auth-page">
        <div className="auth-page__card">
          <h2 className="auth-modal__title">{t(k('successTitle'))}</h2>
          <p className="auth-modal__text">{t(k('successText'))}</p>
        </div>
      </div>
    )
  }

  // --- Denied ----------------------------------------------------------------
  if (denied) {
    return (
      <div className="auth-page">
        <div className="auth-page__card">
          <h2 className="auth-modal__title">{t(k('deniedTitle'))}</h2>
          <p className="auth-modal__text">{t(k('deniedText'))}</p>
        </div>
      </div>
    )
  }

  // --- Not signed in: gate behind login -------------------------------------
  // The AuthModal stays on this same URL (incl. ?code=), so after sign-in the
  // page re-renders into the consent state with the code preserved.
  if (!isAuthenticated) {
    return (
      <div className="auth-page">
        <div className="auth-page__card">
          <h2 className="auth-modal__title">{t(k('signInTitle'))}</h2>
          <p className="auth-modal__text">{t(k('signInText'))}</p>
          <button className="auth-modal__btn" onClick={openAuthModal}>
            {t(k('signInBtn'))}
          </button>
        </div>
      </div>
    )
  }

  // --- Signed in: confirm code + consent ------------------------------------
  return (
    <div className="auth-page">
      <div className="auth-page__card">
        <h2 className="auth-modal__title">{t(k('consentTitle'))}</h2>
        <p className="auth-modal__text">
          {t(k('consentLead'), { email: user?.email || '' })}
        </p>
        <p className="auth-modal__text">{t(k('consentScope'))}</p>
        <p className="auth-modal__text">
          <strong>{t(k('consentWarning'))}</strong>
        </p>
        <form onSubmit={handleApprove}>
          <label className="auth-modal__text" htmlFor="device-code">
            {t(k('codeLabel'))}
          </label>
          <input
            id="device-code"
            type="text"
            className="auth-modal__input"
            placeholder={t(k('codePlaceholder'))}
            value={code}
            onChange={(e) => setCode(formatUserCode(e.target.value))}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            autoFocus={!code}
          />
          {errorMsg && <p className="auth-modal__error">{errorMsg}</p>}
          <button className="auth-modal__btn" type="submit" disabled={submitting || !code}>
            {submitting ? t(k('submitting')) : t(k('approve'))}
          </button>
          <button
            type="button"
            className="auth-modal__btn"
            onClick={handleDeny}
            disabled={submitting}
            style={{ background: 'transparent', color: 'var(--color-text-secondary)' }}
          >
            {t(k('cancel'))}
          </button>
        </form>
      </div>
    </div>
  )
}
