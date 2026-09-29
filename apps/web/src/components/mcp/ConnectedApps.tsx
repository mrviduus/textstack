import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useTranslation } from '../../hooks/useTranslation'
import { listOAuthGrants, revokeOAuthGrant, type OAuthGrant } from '../../api/oauth'

const day = (iso: string) => new Date(iso).toLocaleDateString()

/**
 * Assistants the reader approved on the OAuth consent page (ADR-017). Disconnect revokes the grant;
 * the server refuses its token on the next request, so the row can go at once.
 */
export function ConnectedApps() {
  const { t } = useTranslation()
  const { isAuthenticated } = useAuth()
  const [grants, setGrants] = useState<OAuthGrant[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isAuthenticated) return
    listOAuthGrants().then(setGrants).catch(() => setError(t('connect.apps.loadFailed')))
  }, [isAuthenticated, t])

  if (!isAuthenticated) return null

  const disconnect = async (id: string) => {
    setError(null)
    try {
      await revokeOAuthGrant(id)
      setGrants(g => (g ?? []).filter(x => x.id !== id))
    } catch {
      setError(t('connect.apps.disconnectFailed'))
    }
  }

  return (
    <section className="mcp-section mcp-connect">
      <h2 className="mcp-section__heading">{t('connect.apps.heading')}</h2>
      {error && <p className="mcp-connect__error" role="alert">{error}</p>}
      {grants === null ? null : grants.length === 0 ? (
        <p className="mcp-connect__empty">{t('connect.apps.empty')}</p>
      ) : (
        <ul className="mcp-connect__list">
          {grants.map(g => (
            <li key={g.id} className="mcp-connect__item">
              <div>
                <span className="mcp-connect__name">{g.clientName}</span>
                <span className="mcp-connect__used">
                  {t('connect.apps.returnsTo')} <strong>{g.redirectHost}</strong>
                  {' · '}{t('connect.apps.connectedOn')} {day(g.createdAt)}
                  {' · '}{g.lastUsedAt ? `${t('connect.apps.lastUsed')} ${day(g.lastUsedAt)}` : t('connect.neverUsed')}
                </span>
              </div>
              <button type="button" className="mcp-connect__revoke" onClick={() => disconnect(g.id)}>
                {t('connect.apps.disconnect')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
