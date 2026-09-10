import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useTranslation } from '../../hooks/useTranslation'
import { listMcpKeys, createMcpKey, revokeMcpKey, type McpKey, type CreatedMcpKey } from '../../api/mcpKeys'
// Pure, and shared on purpose: a key minted on the phone is the same key here, so both platforms
// must hand out the same snippet and the same default name.
import { claudeDesktopConfig, defaultKeyName, liveKeys } from '@textstack/shared'

/**
 * Create and manage the connect keys that let an outside assistant reach the reader's books.
 *
 * <p>This is the whole onboarding. Before it, connecting Claude meant installing a .NET CLI, running
 * a device flow in a terminal, copying a JWT out of a cache file — and repeating within the hour,
 * because the only credential the remote endpoint accepted expired in sixty minutes. Nobody away
 * from a terminal could do it and nobody at all could do it from a phone, which is the honest
 * explanation for zero conclusions ever coming back.</p>
 *
 * <p>The key is shown exactly once. The server keeps a SHA-256 and nothing else, so "copy it now" is
 * a statement of fact rather than a nudge — hence the persistent panel rather than a toast.</p>
 */
export function ConnectAssistant() {
  const { t } = useTranslation()
  const { isAuthenticated, openAuthModal } = useAuth()

  const [keys, setKeys] = useState<McpKey[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<CreatedMcpKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'key' | 'config' | null>(null)

  // Deliberately does NOT clear `error` on success. The mount refresh and a user action overlap:
  // a create that failed at 200ms would have its message wiped by a list that succeeded at 300ms,
  // leaving a button that visibly did nothing. Each action clears the error it is about to replace.
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setKeys(await listMcpKeys())
    } catch {
      setError(t('mcp.connect.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (isAuthenticated) void refresh()
  }, [isAuthenticated, refresh])

  const create = async () => {
    setCreating(true)
    setError(null)
    try {
      const key = await createMcpKey(defaultKeyName(new Date()))
      setCreated(key)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.connect.createFailed'))
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (id: string) => {
    setError(null)
    try {
      await revokeMcpKey(id)
      // A revoked key stops authenticating immediately; if the one on screen was just revoked, the
      // panel must go with it rather than keep offering a dead string to copy.
      if (created && created.id === id) setCreated(null)
      await refresh()
    } catch {
      setError(t('mcp.connect.revokeFailed'))
    }
  }

  const copy = async (text: string, which: 'key' | 'config') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      /* clipboard unavailable — the value is selectable on screen either way */
    }
  }

  if (!isAuthenticated) {
    return (
      <section className="mcp-section mcp-connect">
        <h2 className="mcp-section__heading">{t('mcp.connect.heading')}</h2>
        <p className="mcp-section__lead">{t('mcp.connect.signInLead')}</p>
        <button type="button" className="mcp-connect__btn" onClick={openAuthModal}>
          {t('mcp.connect.signInCta')}
        </button>
      </section>
    )
  }

  const live = liveKeys(keys)

  return (
    <section className="mcp-section mcp-connect">
      <h2 className="mcp-section__heading">{t('mcp.connect.heading')}</h2>
      <p className="mcp-section__lead">{t('mcp.connect.lead')}</p>

      {error && <p className="mcp-connect__error" role="alert">{error}</p>}

      {created && (
        <div className="mcp-connect__fresh">
          <p className="mcp-connect__once">{t('mcp.connect.shownOnce')}</p>

          <div className="mcp-connect__keyrow">
            <code className="mcp-connect__key">{created.key}</code>
            <button type="button" className="mcp-connect__copy" onClick={() => copy(created.key, 'key')}>
              {copied === 'key' ? t('mcp.copied') : t('mcp.copy')}
            </button>
          </div>

          <p className="mcp-connect__configlabel">{t('mcp.connect.configLabel')}</p>
          <div className="mcp-connect__keyrow">
            <pre className="mcp-connect__config"><code>{claudeDesktopConfig(created.key)}</code></pre>
            <button
              type="button"
              className="mcp-connect__copy"
              onClick={() => copy(claudeDesktopConfig(created.key), 'config')}
            >
              {copied === 'config' ? t('mcp.copied') : t('mcp.copy')}
            </button>
          </div>
        </div>
      )}

      <button type="button" className="mcp-connect__btn" onClick={create} disabled={creating}>
        {creating ? t('mcp.connect.creating') : t('mcp.connect.createCta')}
      </button>

      {loading && live.length === 0 ? null : live.length === 0 ? (
        <p className="mcp-connect__empty">{t('mcp.connect.empty')}</p>
      ) : (
        <ul className="mcp-connect__list">
          {live.map(k => (
            <li key={k.id} className="mcp-connect__item">
              <div>
                <span className="mcp-connect__name">{k.name}</span>
                <code className="mcp-connect__prefix">{k.prefix}…</code>
                <span className="mcp-connect__used">
                  {k.lastUsedAt ? t('mcp.connect.usedRecently') : t('mcp.connect.neverUsed')}
                </span>
              </div>
              <button type="button" className="mcp-connect__revoke" onClick={() => revoke(k.id)}>
                {t('mcp.connect.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
